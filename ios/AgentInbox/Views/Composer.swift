import PhotosUI
import SwiftUI

struct Composer: View {
    @Environment(RelayStore.self) private var store
    let threadId: String
    let participants: [Agent]

    @State private var draft = ""
    @State private var pickedItem: PhotosPickerItem?
    @State private var pendingAttachments: [Attachment] = []
    @State private var isUploading = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if !mentionMatches.isEmpty {
                mentionBar
                Divider()
            }
            if !pendingAttachments.isEmpty || isUploading {
                attachmentBar
                Divider()
            }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $pickedItem, matching: .images) {
                    Image(systemName: "photo.on.rectangle")
                        .font(.system(size: 20))
                }
                .disabled(isUploading)

                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 18))
                    .focused($focused)

                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                }
                .disabled(!canSend)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.bar)
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            Task { await attach(item) }
        }
    }

    // MARK: attachments

    private var attachmentBar: some View {
        HStack(spacing: 8) {
            if isUploading { ProgressView().controlSize(.small) }
            ForEach(pendingAttachments) { attachment in
                HStack(spacing: 4) {
                    Image(systemName: "paperclip")
                    Text("Image")
                    Button {
                        pendingAttachments.removeAll { $0.id == attachment.id }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
                .font(.footnote)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(Color(.secondarySystemBackground), in: .capsule)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func attach(_ item: PhotosPickerItem) async {
        isUploading = true
        defer {
            isUploading = false
            pickedItem = nil
        }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        // Re-encode as JPEG so the relay always gets something the app can show back.
        let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.8) ?? data
        if let attachment = try? await store.upload(jpeg, mime: "image/jpeg") {
            pendingAttachments.append(attachment)
        }
    }

    // MARK: mention autocomplete

    /// The `@word` currently being typed, if the caret is inside one.
    private var mentionQuery: String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        let tail = draft[draft.index(after: at)...]
        guard !tail.contains(where: \.isWhitespace) else { return nil }
        if at > draft.startIndex {
            let before = draft[draft.index(before: at)]
            guard before.isWhitespace else { return nil }
        }
        return String(tail)
    }

    private var mentionMatches: [Agent] {
        guard let query = mentionQuery else { return [] }
        return participants.filter {
            query.isEmpty || $0.name.lowercased().hasPrefix(query.lowercased())
        }
    }

    private var mentionBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(mentionMatches) { agent in
                    Button { complete(agent) } label: {
                        HStack(spacing: 4) {
                            Text(agent.avatarEmoji)
                            Text("@\(agent.name)")
                        }
                        .font(.subheadline)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color(.secondarySystemBackground), in: .capsule)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private func complete(_ agent: Agent) {
        guard let at = draft.lastIndex(of: "@") else { return }
        draft = String(draft[..<at]) + "@\(agent.name) "
    }

    // MARK: send

    private var canSend: Bool {
        !isUploading
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !pendingAttachments.isEmpty)
    }

    private func send() {
        // The desktop app rotates a session with /new, so accept it here too.
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed == "/new" || trimmed == "/reset" {
            store.startNewSession(in: threadId)
            draft = ""
            return
        }
        store.send(text: draft, in: threadId, attachments: pendingAttachments)
        draft = ""
        pendingAttachments = []
    }
}
