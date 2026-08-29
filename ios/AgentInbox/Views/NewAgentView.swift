import SwiftUI

/// Add an agent: pick a name and emoji, get a connect token back. The agent
/// itself connects from wherever it runs — the app never starts anything.
struct NewAgentView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var emoji = "🤖"
    @State private var waiting = false

    private let suggestions = ["🤖", "🧠", "🦙", "🐙", "🛰️", "📎", "🔭", "🧪"]

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Mirrors the relay's slug rule so the field previews the real handle.
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
                    Label(
                        "The relay hands you a connect token. Paste it where the agent runs and it shows up here.",
                        systemImage: "info.circle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
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
                        store.mintAgent(name: trimmedName, avatarEmoji: emoji)
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
