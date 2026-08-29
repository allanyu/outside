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
                    if let profile = agent.profile {
                        LabeledContent("profile", value: profile)
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
            } else {
                ContentUnavailableView("Unknown agent", systemImage: "questionmark.circle")
            }
        }
        .navigationTitle(agent?.name ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
    }
}
