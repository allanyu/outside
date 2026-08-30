import AuthenticationServices
import SwiftUI

/// First run and settings are the same form: sign in, or manage the account
/// you signed in with. Relay plumbing is tucked behind Advanced — the address
/// is compiled into the build, so nobody should have to see it.
struct SetupView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var isFirstRun: Bool = false

    @State private var profileName = ""
    @State private var showingAdvanced = false
    @State private var url = ""
    @State private var token = ""
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                if isFirstRun {
                    signIn
                } else {
                    you
                    connection
                    signOut
                    advanced
                }
                if let joinError = store.joinError {
                    Section { Text(joinError).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle(isFirstRun ? "Agent Inbox" : "Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !isFirstRun {
                    ToolbarItem(placement: .confirmationAction) {
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

    // MARK: first run

    private var signIn: some View {
        Section {
            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = [.fullName]
            } onCompletion: { handleApple($0) }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 48)
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        } header: {
            Text("Sign in")
        } footer: {
            Text("Your chats are yours alone. Nothing is stored about you but the name you choose.")
        }
    }

    // MARK: settings

    private var you: some View {
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
            Text("Only you can see your chats. Everyone else has their own.")
        }
    }

    private var connection: some View {
        Section("Connection") { ConnectionRow() }
    }

    private var signOut: some View {
        Section {
            Button("Sign out", role: .destructive) { confirmingSignOut = true }
                .confirmationDialog(
                    "Sign out?",
                    isPresented: $confirmingSignOut,
                    titleVisibility: .visible
                ) {
                    Button("Sign out", role: .destructive) {
                        store.signOut()
                        dismiss()
                    }
                } message: {
                    Text("Your chats stay on the relay. Signing back in brings them back.")
                }
        } footer: {
            Text("Signing in with Apple again returns you to this same account.")
        }
    }

    private var advanced: some View {
        Section {
            DisclosureGroup("Advanced", isExpanded: $showingAdvanced) {
                TextField("Server address", text: $url)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Account token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Connect") {
                    store.save(relayURL: url, token: token)
                    store.connect()
                    if !isFirstRun { dismiss() }
                }
                .disabled(
                    url.trimmingCharacters(in: .whitespaces).isEmpty
                        || token.trimmingCharacters(in: .whitespaces).isEmpty
                )
            }
        } footer: {
            Text("For pointing at a different server, or signing in with a token you already have.")
        }
    }

    // MARK: sign in with Apple

    private func handleApple(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let auth):
            guard
                let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                let identityToken = credential.identityToken
            else {
                store.joinError = "Apple didn't return a usable sign-in."
                return
            }
            // Apple sends the name only on the very first sign-in.
            let name = [credential.fullName?.givenName, credential.fullName?.familyName]
                .compactMap { $0 }
                .joined(separator: " ")
            Task { await store.signInWithApple(identityToken: identityToken, fullName: name) }
        case .failure(let error):
            switch (error as? ASAuthorizationError)?.code {
            case .canceled:
                // Backing out is not an error worth showing.
                return
            case .unknown, .failed:
                // The usual cause is a build without the entitlement (any
                // simulator build) or a device not signed in to an Apple ID.
                store.joinError = """
                Apple couldn't complete that sign-in. On a simulator this \
                never works — try it on a real device, and check the device \
                is signed in to an Apple ID.
                """
            default:
                store.joinError = error.localizedDescription
            }
        }
    }
}

struct ConnectionRow: View {
    @Environment(RelayStore.self) private var store

    var body: some View {
        HStack {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(label).foregroundStyle(.secondary)
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
