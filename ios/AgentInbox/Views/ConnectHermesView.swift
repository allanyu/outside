import SwiftUI
import UIKit

/// What to do on the machine where Hermes runs. Everything here is one-time:
/// once the gateway is connected, new bots become chats on their own.
struct ConnectHermesView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var copied: String?

    private var server: String {
        store.agentFacingURL.isEmpty ? store.relayURL : store.agentFacingURL
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Run these on the Mac where Hermes runs. Your bots become chats here as soon as its gateway starts.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("1. Install the plugin") {
                    CommandBlock(
                        text: """
                        hermes plugins install allanyu/outside/adapters/hermes/agentinbox
                        hermes plugins enable agentinbox-platform
                        """,
                        label: "Install command",
                        copied: $copied
                    )
                }

                Section {
                    CommandBlock(
                        text: """
                        AGENTINBOX_RELAY_URL=\(server)
                        AGENTINBOX_TOKEN=\(store.gatewayToken ?? "…")
                        AGENTINBOX_ALLOWED_USERS=user
                        """,
                        label: "Settings",
                        copied: $copied
                    )
                } header: {
                    Text("2. Add to ~/.hermes/.env")
                } footer: {
                    Text("This token is how your Hermes proves it is yours. Treat it like a password.")
                }

                Section {
                    CommandBlock(text: "hermes gateway", label: "Command", copied: $copied)
                } header: {
                    Text("3. Start the gateway")
                } footer: {
                    Text("Also enable the platform in ~/.hermes/config.yaml:\nplatforms:\n  agentinbox:\n    enabled: true")
                }
            }
            .navigationTitle("Connect Hermes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .overlay(alignment: .bottom) {
                if let copied {
                    Text("\(copied) copied")
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.thickMaterial, in: .capsule)
                        .padding(.bottom, 24)
                }
            }
            .animation(.easeInOut(duration: 0.15), value: copied)
            .task { store.requestGatewayToken() }
        }
    }
}

private struct CommandBlock: View {
    let text: String
    let label: String
    @Binding var copied: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                UIPasteboard.general.string = text
                copied = label
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Color.accentColor.opacity(0.15), in: .capsule)
                    .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 4)
    }
}
