import SwiftUI
import UIKit

/// One line, run where the agent lives. It pairs, installs the plugin, writes
/// the credential and starts the gateway.
struct ConnectHermesView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Paste this into a terminal on the Mac where Hermes runs.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(store.connectCommand)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button {
                        UIPasteboard.general.string = store.connectCommand
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy", systemImage: "doc.on.doc")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(Color.accentColor.opacity(0.15), in: .capsule)
                            .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                    .disabled(store.pairCode == nil)
                } footer: {
                    Text("The code in it works once and expires in 15 minutes.")
                }

                Section {
                    Label("Installs the Agent Inbox plugin", systemImage: "checkmark.circle")
                    Label("Connects it to your account", systemImage: "checkmark.circle")
                    Label("Restarts the gateway", systemImage: "checkmark.circle")
                } header: {
                    Text("What it does")
                } footer: {
                    Text("Your bots appear here a few seconds later. New ones show up on their own.")
                }
            }
            .navigationTitle("Connect Hermes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("New code") {
                        copied = false
                        store.requestPairCode()
                    }
                }
            }
            .task { store.requestPairCode() }
        }
    }
}
