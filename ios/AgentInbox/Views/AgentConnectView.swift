import SwiftUI
import UIKit

/// The payoff screen: everything needed to connect this agent, in one place.
/// Reachable again later from the agent's detail screen.
struct AgentConnectView: View {
    @Environment(RelayStore.self) private var store
    let agentId: String
    var isNew: Bool = false
    /// Set when this screen was pushed straight after creating the agent, so
    /// "Done" closes the whole sheet instead of returning to an empty form.
    var onDone: (() -> Void)?

    enum Recipe: String, CaseIterable, Identifiable {
        case hermes = "Hermes"
        case other = "Anything else"
        var id: String { rawValue }
    }

    @State private var recipe: Recipe = .hermes
    @State private var copied: String?

    private var agent: Agent? { store.agent(agentId) }
    private var token: String { agent?.connectToken ?? "" }
    private var relay: String {
        store.agentFacingURL.isEmpty ? store.relayURL : store.agentFacingURL
    }

    var body: some View {
        List {
            if let agent, agent.isHosted {
                Section { header(agent) }
                Section {
                    Label(
                        "Runs on @\(store.host(of: agent)?.name ?? "another agent")'s connection. Nothing to install, nothing to configure.",
                        systemImage: "checkmark.seal"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            } else if let agent {
                Section { header(agent) }

                Section {
                    Picker("Setup", selection: $recipe) {
                        ForEach(Recipe.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }

                Section {
                    CodeBlock(text: command, copiedLabel: $copied)
                } header: {
                    Text(recipe == .hermes ? "Run this where Hermes lives" : "Set these where the agent runs")
                } footer: {
                    Text(footnote)
                }

                Section("Details") {
                    CopyRow(label: "Relay", value: relay, copiedLabel: $copied)
                    CopyRow(label: "Token", value: token, copiedLabel: $copied, monospaced: true)
                }
            } else {
                ContentUnavailableView("Agent removed", systemImage: "person.slash")
            }
        }
        .navigationTitle(isNew ? "Connect \(agent?.name ?? "")" : "Connect")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(onDone != nil)
        .toolbar {
            if let onDone {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone)
                }
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
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: copied)
    }

    private func header(_ agent: Agent) -> some View {
        HStack(spacing: 12) {
            AvatarView(emoji: agent.avatarEmoji, online: agent.isOnline, size: 52)
            VStack(alignment: .leading, spacing: 3) {
                Text("@\(agent.name)").font(.title3.weight(.semibold))
                if agent.isOnline {
                    Label("Connected", systemImage: "checkmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.green)
                } else {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Waiting for it to connect…")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var command: String {
        switch recipe {
        case .hermes:
            return store.hermesInstallCommand(for: agent ?? placeholder)
        case .other:
            return """
            RELAY_URL=\(relay)
            RELAY_TOKEN=\(token)
            """
        }
    }

    private var footnote: String {
        switch recipe {
        case .hermes:
            return "Point <hermes-checkout> at your hermes-agent folder. The script copies the plugin in and writes the two variables to its .env — then run `hermes gateway`."
        case .other:
            return "Any adapter that speaks /ws/agent works. This token names the agent, so its register message doesn't need an agent id."
        }
    }

    private var placeholder: Agent {
        Agent(id: agentId, name: agentId, avatarEmoji: "🤖", status: "offline", lastSeen: 0, connectToken: nil)
    }
}

private struct CodeBlock: View {
    let text: String
    @Binding var copiedLabel: String?

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
                copiedLabel = "Command"
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

private struct CopyRow: View {
    let label: String
    let value: String
    @Binding var copiedLabel: String?
    var monospaced: Bool = false

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copiedLabel = label
        } label: {
            HStack {
                Text(label).foregroundStyle(.secondary)
                Spacer()
                Text(value)
                    .font(monospaced ? .system(.subheadline, design: .monospaced) : .subheadline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "doc.on.doc")
                    .font(.caption)
                    .foregroundStyle(Color.accentColor)
            }
        }
        .buttonStyle(.plain)
    }
}
