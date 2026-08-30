import SwiftUI
import UIKit

/// Open one short address on the Mac where the agent runs. Everything else
/// happens there — installing the plugin and pasting the code.
struct ConnectHermesView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var copied: String?
    @State private var showingTerminal = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("On the Mac where Hermes runs, open this address:")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Text(store.setupURL)
                        .font(.system(.title3, design: .monospaced).weight(.medium))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)

                    Button {
                        UIPasteboard.general.string = "https://" + store.setupURL
                        copied = "Address"
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(Color.accentColor.opacity(0.15), in: .capsule)
                            .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                    .disabled(store.pairCode == nil)
                } footer: {
                    Text("It walks you through it there. The code works once and expires in 15 minutes.")
                }

                Section {
                    Label("Adds the plugin to Hermes", systemImage: "checkmark.circle")
                    Label("Connects it to your account", systemImage: "checkmark.circle")
                    Label("Your bots become chats here", systemImage: "checkmark.circle")
                } header: {
                    Text("What happens")
                }

                Section {
                    DisclosureGroup("Rather use a terminal?", isExpanded: $showingTerminal) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(store.connectCommand)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                        }
                        Button("Copy command") {
                            UIPasteboard.general.string = store.connectCommand
                            copied = "Command"
                        }
                        .font(.subheadline)
                    }
                } footer: {
                    Text("Does the same thing in one line.")
                }
            }
            .navigationTitle("Connect Hermes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .cancellationAction) {
                    Button("New code") { store.requestPairCode() }
                }
            }
            .overlay(alignment: .bottom) {
                if let copied {
                    Text("\(copied) copied")
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.thickMaterial, in: .capsule)
                        .padding(.bottom, 24)
                }
            }
            .animation(.easeInOut(duration: 0.15), value: copied)
            .task { store.requestPairCode() }
        }
    }
}
