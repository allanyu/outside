import SwiftUI
import UIKit

/// Invite someone onto this relay. They get their own account — their own
/// agents and threads, no sight of yours.
struct InviteView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Their name (optional)", text: $name)
                    Button("Create invite") {
                        store.createInvite(name: name)
                    }
                } footer: {
                    Text("Each invite works once.")
                }

                if let invite = store.lastInvite {
                    Section {
                        Text(invite.code)
                            .font(.system(.title2, design: .monospaced).weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)

                        ShareLink(item: store.inviteLink(invite)) {
                            Label("Share invite link", systemImage: "square.and.arrow.up")
                        }

                        Button {
                            UIPasteboard.general.string = store.inviteLink(invite)
                            copied = true
                        } label: {
                            Label(copied ? "Copied" : "Copy link", systemImage: "doc.on.doc")
                        }
                    } header: {
                        Text("Send them this")
                    } footer: {
                        Text("Opening the link on their phone puts them straight into a fresh account. If they'd rather type it, give them the relay address and the code.")
                    }
                }
            }
            .navigationTitle("Invite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
