import SwiftUI

struct SetupView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var isFirstRun: Bool = false

    @State private var url: String = ""
    @State private var token: String = ""
    @State private var inviteCode: String = ""
    @State private var joining = false
    @State private var profileName: String = ""

    private var canConnect: Bool {
        !url.trimmingCharacters(in: .whitespaces).isEmpty
            && !token.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                if isFirstRun {
                    Section {
                        if !Config.hasDefaultRelay {
                            TextField("http://192.168.1.20:8787", text: $url)
                                .textContentType(.URL)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        TextField("Invite code", text: $inviteCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                        Button(joining ? "Joining…" : "Join") {
                            joining = true
                            Task {
                                await store.join(relayURL: url, code: inviteCode)
                                joining = false
                            }
                        }
                        .disabled(url.isEmpty || inviteCode.isEmpty || joining)
                    } header: {
                        Text(Config.hasDefaultRelay ? "Enter your invite code" : "Have an invite?")
                    } footer: {
                        Text("Tapping the invite link does this for you. You get your own agents and threads — nobody else's.")
                    }

                    if let joinError = store.joinError {
                        Section { Text(joinError).font(.footnote).foregroundStyle(.red) }
                    }
                }

                Section {
                    TextField("http://192.168.1.20:8787", text: $url)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Relay token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text(isFirstRun ? "Or connect with a token" : "Relay")
                } footer: {
                    Text("The relay prints both lines when it starts.")
                }

                Section {
                    Button("Connect") {
                        store.save(relayURL: url, token: token)
                        store.connect()
                        if !isFirstRun { dismiss() }
                    }
                    .disabled(!canConnect)
                }

                if !isFirstRun {
                    Section {
                        TextField("Your name", text: $profileName)
                            .autocorrectionDisabled()
                            .onSubmit { store.setProfileName(profileName) }
                        Button("Save name") { store.setProfileName(profileName) }
                            .disabled(
                                profileName.trimmingCharacters(in: .whitespaces).isEmpty
                                    || profileName == store.account?.name
                            )
                    } header: {
                        Text("You")
                    } footer: {
                        Text(store.account?.isOwner == true
                             ? "You set this relay up, so you can invite other people onto it."
                             : "Only you can see your chats. Other people on this relay have their own.")
                    }

                    Section {
                        ConnectionRow()
                        Button("Disconnect", role: .destructive) {
                            store.signOut()
                            dismiss()
                        }
                    }
                }

                if case .failed(let message) = store.connection {
                    Section("Last error") {
                        Text(message).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(isFirstRun ? "Agent Inbox" : "Relay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !isFirstRun {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            }
            .onAppear {
                url = store.relayURL.isEmpty ? Config.defaultRelayURL : store.relayURL
                token = store.token
                profileName = store.account?.name ?? ""
            }
            .onChange(of: store.account?.name) { _, name in
                if let name, profileName.isEmpty { profileName = name }
            }
        }
    }
}

struct ConnectionRow: View {
    @Environment(RelayStore.self) private var store

    var body: some View {
        HStack {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .foregroundStyle(.secondary)
        }
        .font(.footnote)
    }

    private var color: Color {
        switch store.connection {
        case .connected: .green
        case .connecting: .orange
        case .failed: .red
        case .idle: .gray
        }
    }

    private var label: String {
        switch store.connection {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .failed: "Disconnected — retrying"
        case .idle: "Not connected"
        }
    }
}
