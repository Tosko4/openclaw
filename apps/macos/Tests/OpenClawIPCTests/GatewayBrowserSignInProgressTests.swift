import Foundation
import Synchronization
import Testing
@testable import OpenClaw

@MainActor
struct GatewayBrowserSignInProgressTests {
    @Test func `a retained button cannot clear a newer sign in`() throws {
        let url = try #require(URL(string: "https://gateway.example.invalid/synthetic"))
        let current = Mutex(true)
        let previous = GatewayBrowserHandoff(url: url) { current.withLock { $0 } }
        let progress = GatewayBrowserSignInProgress()
        progress.update(previous)
        #expect(progress.canOpenBrowser)

        current.withLock { $0 = false }
        let replacement = GatewayBrowserHandoff(url: url) { true }
        progress.update(replacement)
        progress.openBrowser(previous)

        #expect(progress.handoff?.id == replacement.id)
        #expect(progress.canOpenBrowser)
        #expect(progress.error == nil)
        progress.update(nil)
        #expect(!progress.canOpenBrowser)
    }
}
