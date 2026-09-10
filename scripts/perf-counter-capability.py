#!/usr/bin/env python3
"""Self-owned Linux/x86_64 counting diagnostic; never a Kova metric or verdict."""
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import signal
import struct
import sys
import threading
import time

# Linux v6.6.141 UAPI: perf_event.h and arch/x86/entry/syscalls/syscall_64.tbl.
PERF_EVENT_OPEN = 298
PERF_EVENT_IOC_ENABLE = 0x2400
PERF_FLAG_FD_CLOEXEC = 8
PERF_ATTR_SIZE_VER0 = 64
PERF_FORMAT_TOTAL_TIME_ENABLED = 1
PERF_FORMAT_TOTAL_TIME_RUNNING = 2
INHERIT = 1 << 1
INHERIT_THREAD = 1 << 35
BURN_NS = 25_000_000


def abort_probe(_signal, _frame):
    raise TimeoutError("diagnostic process deadline or termination signal")


def emit(fd, payload):
    os.write(fd, (json.dumps(payload, separators=(",", ":")) + "\n").encode())


def burn():
    start = time.thread_time_ns()
    value = 1
    while time.thread_time_ns() - start < BURN_NS:
        value = (value * 1664525 + 1013904223) & 0xFFFFFFFF
    return {"tid": threading.get_native_id(), "thread_cpu_ns": time.thread_time_ns() - start}


def worker(control, reports):
    emit(reports, {"phase": "exec_ready", "pid": os.getpid()})
    for phase in ("threads", "children", "owner_exit"):
        if os.read(control, 1) != b"G":
            os._exit(10)
        if phase == "threads":
            refs = []
            threads = [threading.Thread(target=lambda: refs.append(burn())) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            details = {"joined_threads": refs,
                       "live_tids": sorted(int(p.name) for p in Path("/proc/self/task").iterdir())}
        elif phase == "children":
            child_refs = []
            for nested in (False, True):
                read_fd, write_fd = os.pipe()
                pid = os.fork()
                if pid == 0:
                    os.close(read_fd)
                    own = burn()
                    grandchild = None
                    if nested:
                        grandchild = os.fork()
                        if grandchild == 0:
                            burn()
                            os._exit(0)
                        _, status = os.waitpid(grandchild, 0)
                        if status != 0:
                            os._exit(11)
                    emit(write_fd, {"pid": os.getpid(), "own": own,
                                    "waited_grandchild_pid": grandchild})
                    os._exit(0)
                os.close(write_fd)
                _, status, usage = os.wait4(pid, 0)
                data = os.read(read_fd, 4096)
                os.close(read_fd)
                if status != 0:
                    raise RuntimeError("synthetic child failed")
                child_refs.append({"child": json.loads(data), "wait_status": status,
                                   "wait4_user_s": usage.ru_utime, "wait4_system_s": usage.ru_stime})
            details = {"reaped_children": child_refs}
        else:
            details = {"owner": burn()}
        emit(reports, {"phase": phase, **details})
    os._exit(0)


def open_counter(pid, flags):
    # VER0 is sufficient: inherit_thread occupies an existing flags-word bit.
    attr = ctypes.create_string_buffer(PERF_ATTR_SIZE_VER0)
    struct.pack_into("=IIQQQQQIIQ", attr, 0, 1, PERF_ATTR_SIZE_VER0, 1, 0, 0,
                     PERF_FORMAT_TOTAL_TIME_ENABLED | PERF_FORMAT_TOTAL_TIME_RUNNING,
                     1 | flags, 0, 0, 0)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    fd = libc.syscall(ctypes.c_long(PERF_EVENT_OPEN), ctypes.byref(attr), ctypes.c_int(pid),
                      ctypes.c_int(-1), ctypes.c_int(-1), ctypes.c_ulong(PERF_FLAG_FD_CLOEXEC))
    if fd < 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    return fd


def snapshot(counters, label):
    readings = {}
    for name, fd in counters.items():
        before = time.monotonic_ns()
        raw = os.read(fd, 24)
        after = time.monotonic_ns()
        if len(raw) != 24:
            raise RuntimeError("short perf counter read")
        value, enabled, running = struct.unpack("=QQQ", raw)
        readings[name] = {"task_clock_ns": value, "time_enabled_ns": enabled,
                          "time_running_ns": running, "read_start_ns": before,
                          "read_end_ns": after}
    return {"label": label, "readings": readings}


def metadata():
    info = {"kernel": platform.release(), "machine": platform.machine(),
            "euid": os.geteuid(), "affinity": sorted(os.sched_getaffinity(0)),
            "clock_tick_hz": os.sysconf("SC_CLK_TCK"),
            "monotonic_resolution_s": time.get_clock_info("monotonic").resolution,
            "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "workflow_sha": os.environ.get("PROBE_WORKFLOW_SHA"),
            "frozen_tooling_sha": os.environ.get("PROBE_FROZEN_TOOLING_SHA"),
            "requested_runner": os.environ.get("PROBE_REQUESTED_RUNNER"),
            "run_id": os.environ.get("GITHUB_RUN_ID"),
            "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT")}
    for name in ("perf_event_paranoid", "perf_event_mlock_kb", "perf_event_max_sample_rate"):
        file = Path("/proc/sys/kernel") / name
        info[name] = file.read_text().strip() if file.exists() else None
    info["process_constraints"] = [line for line in Path("/proc/self/status").read_text().splitlines()
                                   if line.startswith(("CapEff:", "NoNewPrivs:", "Seccomp:"))]
    return info


def diagnose():
    report = {"schema_version": 1, "purpose": "perf-task-clock-capability-only",
              "metric_equivalence": "not_established", "qualification_verdict": None,
              "status": "incomplete", "metadata": metadata(), "opens": [],
              "snapshots": [], "workload": []}
    counters = {}
    pid = None
    reaped = False
    fds = []
    try:
        if sys.platform != "linux" or platform.machine() != "x86_64":
            raise RuntimeError("this probe is pinned to the original Linux/x86_64 runner ABI")
        control_r, control_w = os.pipe()
        report_r, report_w = os.pipe()
        fds = [control_r, control_w, report_r, report_w]
        os.set_inheritable(control_r, True)
        os.set_inheritable(report_w, True)
        pid = os.fork()
        if pid == 0:
            try:
                os.close(control_w)
                os.close(report_r)
                os.setpgid(0, 0)
                if os.read(control_r, 1) != b"E":
                    os._exit(12)
                os.execv(sys.executable, [sys.executable, "-I", "-S", str(Path(__file__).resolve()),
                                         "--worker", str(control_r), str(report_w)])
            finally:
                # A failed exec must not enter the parent's report/cleanup path.
                os._exit(127)
        os.setpgid(pid, pid)
        os.close(control_r)
        os.close(report_w)
        fds = [control_w, report_r]
        report["owner_pid"] = pid
        for name, flags in (("leader", 0), ("threads", INHERIT | INHERIT_THREAD), ("tree", INHERIT)):
            try:
                counters[name] = open_counter(pid, flags)
            except OSError as error:
                report["opens"].append({"scope": name, "flags": flags, "available": False,
                                        "errno": error.errno, "error": error.strerror})
                report["status"] = "unavailable"
                return report, 2
            report["opens"].append({"scope": name, "flags": flags, "available": True})
        for fd in counters.values():
            fcntl.ioctl(fd, PERF_EVENT_IOC_ENABLE, 0)
        report["snapshots"].append(snapshot(counters, "before_exec"))
        os.write(control_w, b"E")
        buffer = b""

        def receive(phase):
            nonlocal buffer
            deadline = time.monotonic() + 5
            while b"\n" not in buffer:
                if time.monotonic() >= deadline:
                    raise TimeoutError("synthetic workload phase timed out")
                readable, _, _ = select.select([report_r], [], [], 0.005)
                if len(report["snapshots"]) >= 512:
                    raise RuntimeError("diagnostic sample bound exceeded")
                report["snapshots"].append(snapshot(counters, "running_" + phase))
                if readable:
                    data = os.read(report_r, 16384)
                    if not data:
                        raise RuntimeError("synthetic workload closed without phase evidence")
                    buffer += data
            line, buffer = buffer.split(b"\n", 1)
            payload = json.loads(line)
            if payload.get("phase") != phase:
                raise RuntimeError("synthetic workload phase ordering mismatch")
            report["workload"].append(payload)
            result = snapshot(counters, "after_" + phase)
            report["snapshots"].append(result)
            return result

        ready = receive("exec_ready")
        phase_samples = [ready]
        for phase in ("threads", "children", "owner_exit"):
            os.write(control_w, b"G")
            phase_samples.append(receive(phase))
        _, status, usage = os.wait4(pid, 0)
        reaped = True
        if status != 0:
            raise RuntimeError("synthetic owner failed")
        report["owner_wait4"] = {"status": status, "user_s": usage.ru_utime,
                                 "system_s": usage.ru_stime}
        terminal = snapshot(counters, "after_owner_reaped")
        retained = snapshot(counters, "retained_fd_immediate_reread")
        report["snapshots"].extend([terminal, retained])
        deltas = []
        for before, after in zip(phase_samples, phase_samples[1:]):
            deltas.append({name: after["readings"][name]["task_clock_ns"] -
                           before["readings"][name]["task_clock_ns"] for name in counters})
        report["phase_deltas_ns"] = dict(zip(("threads", "children", "owner_exit"), deltas))
        report["checks"] = {
            "joined_thread_cpu_visible": deltas[0]["threads"] > deltas[0]["leader"],
            "reaped_child_cpu_visible": deltas[1]["tree"] > deltas[1]["threads"],
            "owner_cpu_visible": deltas[2]["leader"] > 0,
            "read_brackets_ordered": all(
                reading["read_end_ns"] >= reading["read_start_ns"]
                for sample in report["snapshots"] for reading in sample["readings"].values()),
            "unscaled_running_time_complete": all(
                reading["time_running_ns"] == reading["time_enabled_ns"]
                for sample in report["snapshots"] for reading in sample["readings"].values()),
            "counts_monotonic": all(
                b["readings"][name]["task_clock_ns"] >= a["readings"][name]["task_clock_ns"]
                for a, b in zip(report["snapshots"], report["snapshots"][1:]) for name in counters),
            "retained_after_owner_reaped": all(terminal["readings"][name]["task_clock_ns"] ==
                                               retained["readings"][name]["task_clock_ns"]
                                               for name in counters),
        }
        report["status"] = "observed" if all(report["checks"].values()) else "inconsistent"
        return report, 0 if report["status"] == "observed" else 1
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        return report, 1
    finally:
        if pid is not None and not reaped:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        for fd in [*counters.values(), *fds]:
            os.close(fd)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--worker":
        worker(int(sys.argv[2]), int(sys.argv[3]))
    elif len(sys.argv) == 2:
        signal.signal(signal.SIGALRM, abort_probe)
        signal.signal(signal.SIGTERM, abort_probe)
        signal.alarm(20)
        result, code = diagnose()
        signal.alarm(0)
        Path(sys.argv[1]).write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"status": result["status"], "metric_equivalence": "not_established"}))
        sys.exit(code)
    else:
        raise SystemExit("usage: perf-counter-capability.py OUTPUT.json")
