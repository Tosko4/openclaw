package ai.openclaw.wear

import android.media.AudioRecord
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35], shadows = [FailingRestartAudioRecord::class])
class WearAudioFailureTest {
  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun failedRecorderRestartReachesTheViewModelErrorAndClosesAttempt() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val owner =
        object : ViewModelStoreOwner {
          override val viewModelStore = ViewModelStore()
        }
      val app = RuntimeEnvironment.getApplication() as WearApplication
      val vm = ViewModelProvider(owner, ViewModelProvider.AndroidViewModelFactory.getInstance(app))[WearViewModel::class.java]
      val client = vm.talkTestField("realtimeTalkClient") as WearRealtimeTalkClient
      val fixture = WearTalkTestFixture(app, client)
      (vm.talkTestField("loadJob") as? Job)?.cancel()
      (client.talkTestField("scope") as CoroutineScope).cancel()
      client.setTalkTestField("scope", CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)))
      try {
        testScheduler.runCurrent()
        fixture.activate()
        vm.setTalkTestField("talkAttemptId", "attempt-1")
        client.callTalkTestMethod("startCapture", fixture.attempt)
        assertTrue(client.isCapturing.value)
        client.callTalkTestMethod("pauseCaptureLocked")
        FailingRestartAudioRecord.failStart = true
        client.callTalkTestMethod("clearOutput", fixture.attempt, true)
        testScheduler.runCurrent()
        assertTrue("failed restart must signal the production error owner", client.channelFailed.value)
        assertFalse(client.isCapturing.value)
        assertTrue(vm.state.value.realtimePlaybackFailed)
        assertEquals(WearConversationFailure.INTERNAL_ERROR, vm.state.value.failure)
        assertEquals(1, fixture.input.closes.get())
        assertEquals(1, fixture.channelCloses.get())
        fixture.rpcReply.complete(Unit)
        testScheduler.runCurrent()
      } finally {
        FailingRestartAudioRecord.failStart = false
        owner.viewModelStore.clear()
        Dispatchers.resetMain()
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun staleRestartCannotCaptureOrFailTheReplacementAttempt() =
    runTest {
      val fixture = WearTalkTestFixture(RuntimeEnvironment.getApplication())
      val client = fixture.client
      (client.talkTestField("scope") as CoroutineScope).cancel()
      client.setTalkTestField("scope", CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)))
      fixture.activate()
      client.disconnectLocal()
      val replacement = fixture.attempt.copy(generation = 2L, attemptId = "replacement")
      client.callTalkTestMethod("activate", replacement)
      FailingRestartAudioRecord.failStart = true
      try {
        client.callTalkTestMethod("clearOutput", fixture.attempt, true)
        assertFalse(client.channelFailed.value)
        assertFalse(client.isCapturing.value)
        assertEquals(replacement, client.talkTestField("activeAttempt"))
      } finally {
        FailingRestartAudioRecord.failStart = false
        client.shutdown()
      }
    }
}

@Implements(AudioRecord::class)
class FailingRestartAudioRecord {
  @Implementation
  fun getState(): Int = AudioRecord.STATE_INITIALIZED

  @Implementation
  fun startRecording() {
    if (failStart) throw IllegalStateException("controlled recorder restart denial")
  }

  companion object {
    @JvmStatic
    @Implementation
    fun getMinBufferSize(
      sampleRate: Int,
      channelConfig: Int,
      audioFormat: Int,
    ): Int = if (sampleRate > 0 && channelConfig > 0 && audioFormat > 0) 4096 else -1

    var failStart = false
  }
}
