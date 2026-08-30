import SwiftUI
import UIKit

/// Claude Code is not a Hermes profile, so it does not arrive as one of the
/// mirrored chats — it is its own agent, connected by running one command on
/// the machine where Claude Code is installed.
struct ConnectClaudeView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var copied: String?
    @State private var showingTerminal = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("On the Mac where Claude Code is installed, open this address:")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Text(store.claudeSetupURL)
                        .font(.system(.title3, design: .monospaced).weight(.medium))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)

                    Button {
                        UIPasteboard.general.string = "https://" + store.claudeSetupURL
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
                    .disabled(store.claudeCode == nil)
                } footer: {
                    Text("It gives you one command to run. The code works once and expires in 15 minutes.")
                }

                Section {
                    Label("Runs Claude Code as a chat here", systemImage: "checkmark.circle")
                    Label("One chat, one Claude Code session", systemImage: "checkmark.circle")
                    Label("Works in the folder you start it from", systemImage: "checkmark.circle")
                } header: {
                    Text("What happens")
                }

                Section {
                    DisclosureGroup("Rather use a terminal?", isExpanded: $showingTerminal) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(store.claudeCommand)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                        }
                        Button("Copy command") {
                            UIPasteboard.general.string = store.claudeCommand
                            copied = "Command"
                        }
                        .font(.subheadline)
                    }
                } footer: {
                    Text("Run it from the folder you want Claude to work in.")
                }
            }
            .navigationTitle("Connect Claude")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .cancellationAction) {
                    Button("New code") { store.requestClaudeCode() }
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
            .task { store.requestClaudeCode() }
        }
    }
}
