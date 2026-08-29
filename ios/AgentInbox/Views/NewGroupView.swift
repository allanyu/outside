import SwiftUI

struct NewGroupView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var selected: Set<String> = []

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Optional", text: $name)
                }
                Section("Agents") {
                    ForEach(store.agents) { agent in
                        Button {
                            if selected.contains(agent.id) {
                                selected.remove(agent.id)
                            } else {
                                selected.insert(agent.id)
                            }
                        } label: {
                            HStack {
                                AvatarView(emoji: agent.avatarEmoji, online: agent.isOnline, size: 30)
                                Text(agent.name)
                                Spacer()
                                if selected.contains(agent.id) {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle("New Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        store.createThread(
                            kind: selected.count == 1 ? "dm" : "group",
                            name: name,
                            participantIds: Array(selected)
                        )
                        dismiss()
                    }
                    .disabled(selected.isEmpty)
                }
            }
        }
    }
}
