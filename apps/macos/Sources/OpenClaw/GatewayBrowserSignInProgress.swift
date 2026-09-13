import AppKit
import Foundation
import Observation
import SwiftUI

/// A native-only action, never a URL payload for a dashboard or IPC client.
struct GatewayBrowserHandoff: Sendable {
    let id = UUID()
    private let url: URL
    private let isCurrent: @Sendable () -> Bool

    init(url: URL, isCurrent: @escaping @Sendable () -> Bool) {
        self.url = url
        self.isCurrent = isCurrent
    }

    var isAvailable: Bool {
        self.isCurrent()
    }

    func perform<Result>(_ action: (URL) throws -> Result) throws -> Result {
        guard self.isCurrent() else { throw CancellationError() }
        return try action(self.url)
    }
}

@MainActor
@Observable
final class GatewayBrowserSignInProgress {
    private(set) var handoff: GatewayBrowserHandoff?
    var gatewayHost = ""
    private(set) var error: String?
    var onChange: (() -> Void)?

    var canOpenBrowser: Bool {
        self.handoff?.isAvailable == true
    }

    func update(_ handoff: GatewayBrowserHandoff?) {
        self.handoff = handoff
        self.error = nil
        self.onChange?()
    }

    func openBrowser(_ action: GatewayBrowserHandoff) {
        guard self.handoff?.id == action.id else { return }
        do {
            guard try action.perform({ NSWorkspace.shared.open($0) }) else {
                self.error = String(localized: "Could not open your browser. Check your default browser and try again.")
                self.onChange?()
                return
            }
            self.error = nil
        } catch {
            self.handoff = nil
            self.error = String(localized: "This sign-in is no longer active. Start sign-in again.")
        }
        self.onChange?()
    }
}

struct GatewayBrowserSignInProgressView: View {
    let progress: GatewayBrowserSignInProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(self.progress.canOpenBrowser
                    ? String(localized: "Complete sign-in in your browser…") : String(localized: "Connecting…"))
                    .font(.callout)
            }
            if let action = self.progress.handoff, action.isAvailable {
                Button("Open browser") { self.progress.openBrowser(action) }
            }
            if let error = self.progress.error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
    }
}
