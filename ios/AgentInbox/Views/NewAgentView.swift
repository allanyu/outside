import SwiftUI

/// Add an agent: pick a name and emoji, get a connect token back. The agent
/// itself connects from wherever it runs — the app never starts anything.
struct NewAgentView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var emoji = "🤖"
    @State private var waiting = false
    @State private var hostId: String?
    @State private var profile: String?

    private let suggestions = ["🤖", "🧠", "🦙", "🐙", "🛰️", "📎", "🔭", "🧪"]

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Mirrors the relay's slug rule so the field previews the real handle.
    private var selectedHost: Agent? {
        hostId.flatMap { store.agent($0) }
    }

    /// The personas that host reported — Hermes profiles, for instance.
    private func hostProfiles(_ host: Agent) -> [String] {
        host.availableProfiles ?? []
    }

    private var handle: String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789")
        let mapped = trimmedName.lowercased().map { allowed.contains($0) ? $0 : "-" }
        return String(mapped)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("hermes", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Name")
                } footer: {
                    Text(handle.isEmpty
                         ? "This is the @handle you'll type to mention it in a group."
                         : "Mention it as @\(handle). The relay adds a suffix if that handle is taken.")
                }

                Section("Avatar") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(suggestions, id: \.self) { option in
                                Button { emoji = option } label: {
                                    Text(option)
                                        .font(.title2)
                                        .frame(width: 44, height: 44)
                                        .background(
                                            emoji == option
                                                ? AnyShapeStyle(Color.accentColor.opacity(0.18))
                                                : AnyShapeStyle(Color(.secondarySystemBackground)),
                                            in: .circle
                                        )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                Section {
                    Picker("Runs on", selection: $hostId) {
                        ForEach(store.possibleHosts) { host in
                            Text("\(host.avatarEmoji) @\(host.name)").tag(Optional(host.id))
                        }
                        Text("Its own connection").tag(String?.none)
                    }
                    if let host = selectedHost, !hostProfiles(host).isEmpty {
                        Picker("Bot", selection: $profile) {
                            ForEach(hostProfiles(host), id: \.self) { name in
                                Text(name).tag(Optional(name))
                            }
                        }
                    }
                } header: {
                    Text("Runs on")
                } footer: {
                    Text(hostId == nil
                         ? "You get a connect token to paste where the agent runs."
                         : "Served over that agent's existing connection. Nothing to set up, nothing to restart — it is live the moment you tap Create.")
                }
            }
            .onAppear {
                // Default to running on something already connected — that is
                // the path with no setup at all.
                if hostId == nil { hostId = store.possibleHosts.first?.id }
                if profile == nil, let host = selectedHost {
                    profile = hostProfiles(host).first
                }
            }
            .navigationTitle("New Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        waiting = true
                        store.mintAgent(
                            name: trimmedName,
                            avatarEmoji: emoji,
                            hostAgentId: hostId,
                            profile: profile
                        )
                    }
                    .disabled(trimmedName.isEmpty || waiting)
                }
            }
            .navigationDestination(item: Binding(
                get: { waiting ? store.justMinted : nil },
                set: { if $0 == nil { waiting = false } }
            )) { agent in
                AgentConnectView(agentId: agent.id, isNew: true) {
                    store.justMinted = nil
                    dismiss()
                }
            }
        }
    }
}
