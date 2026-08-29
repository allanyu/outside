import SwiftUI

struct AgentDetailView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let agentId: String

    @State private var confirmingRemove = false

    private var agent: Agent? { store.agent(agentId) }

    var body: some View {
        List {
            if let agent {
                Section {
                    HStack(spacing: 12) {
                        AvatarView(emoji: agent.avatarEmoji, online: agent.isOnline, size: 56)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agent.name).font(.title3.weight(.semibold))
                            Text(agent.isOnline ? "Online" : "Offline")
                                .font(.subheadline)
                                .foregroundStyle(agent.isOnline ? .green : .secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section("Identity") {
                    LabeledContent("id", value: agent.id)
                    if let host = store.host(of: agent) {
                        LabeledContent("runs on", value: "@\(host.name)")
                    }
                }
                if agent.hasConnectToken || agent.isHosted {
                    Section {
                        NavigationLink(value: Route.connect(agent.id)) {
                            Label("Connect instructions", systemImage: "link")
                        }
                    } footer: {
                        Text(agent.isHosted
                             ? "Where this agent runs."
                             : "The relay URL and this agent's token, again.")
                    }
                }
                Section("Threads") {
                    ForEach(store.threads(containing: agent.id)) { thread in
                        NavigationLink(value: Route.thread(thread.id)) {
                            HStack {
                                Text(store.emoji(for: thread))
                                Text(store.title(for: thread))
                                Spacer()
                                Text(thread.isDM ? "DM" : "Group")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if agent.hasConnectToken || agent.isHosted {
                    Section {
                        Button("Remove Agent", role: .destructive) { confirmingRemove = true }
                    } footer: {
                        Text("Revokes the token and deletes its DM. Threads it shared with other agents stay.")
                    }
                }
            } else {
                ContentUnavailableView("Unknown agent", systemImage: "questionmark.circle")
            }
        }
        .confirmationDialog(
            "Remove @\(agent?.name ?? "")?",
            isPresented: $confirmingRemove,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                store.deleteAgent(agentId)
                dismiss()
            }
        } message: {
            Text("Its connect token stops working. You can add it again later with a new one.")
        }
        .navigationTitle(agent?.name ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
    }
}
