import SwiftUI

@main
struct AgentInboxApp: App {
    @State private var store = RelayStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .onOpenURL { store.handle(url: $0) }
        }
    }
}

struct RootView: View {
    @Environment(RelayStore.self) private var store

    var body: some View {
        Group {
            if store.isConfigured {
                InboxView()
            } else {
                SetupView(isFirstRun: true)
            }
        }
        .task {
            if store.isConfigured, store.connection == .idle { store.connect() }
        }
    }
}

/// Where the app navigates. Threads and agents are referenced by id so the
/// pushed screen always reads current state instead of a stale copy.
enum Route: Hashable {
    case thread(String)
    case agent(String)
    case connect(String)
}
