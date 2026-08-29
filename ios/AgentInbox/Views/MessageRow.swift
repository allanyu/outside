import SwiftUI

struct MessageRow: View {
    @Environment(RelayStore.self) private var store
    let message: Message
    let showsSender: Bool
    let isGroup: Bool

    private var agent: Agent? { store.agent(message.senderId) }

    var body: some View {
        HStack {
            if message.isFromUser { Spacer(minLength: 48) }

            VStack(alignment: message.isFromUser ? .trailing : .leading, spacing: 4) {
                if showsSender, let agent {
                    NavigationLink(value: Route.agent(agent.id)) {
                        HStack(spacing: 4) {
                            Text(agent.avatarEmoji)
                            Text(agent.name)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 4)
                }

                if message.isApproval, let approval = store.approval(forMessage: message.id) {
                    ApprovalCard(approval: approval)
                } else {
                    bubble
                }
            }
            .padding(.top, showsSender ? 8 : 0)

            if !message.isFromUser { Spacer(minLength: 48) }
        }
    }

    // Attachments sit outside the bubble: an image-only message wrapped in a
    // filled bubble reads as a thick coloured border around the picture.
    private var bubble: some View {
        VStack(alignment: message.isFromUser ? .trailing : .leading, spacing: 6) {
            ForEach(message.attachments) { attachment in
                AttachmentView(attachment: attachment)
            }
            if !message.text.isEmpty {
                Text(markdown(message.text))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        message.isFromUser ? AnyShapeStyle(Color.accentColor)
                                           : AnyShapeStyle(Color(.secondarySystemBackground)),
                        in: .rect(cornerRadius: 18)
                    )
                    .foregroundStyle(
                        message.isFromUser ? AnyShapeStyle(.white) : AnyShapeStyle(Color.primary)
                    )
            }
        }
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }
}

struct AttachmentView: View {
    @Environment(RelayStore.self) private var store
    let attachment: Attachment

    var body: some View {
        if attachment.isImage, let url = store.fileURL(attachment) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .failure:
                    Label("Image unavailable", systemImage: "photo")
                        .font(.footnote)
                        .padding(8)
                default:
                    ProgressView().frame(width: 120, height: 120)
                }
            }
            .frame(maxWidth: 240)
            .clipShape(.rect(cornerRadius: 12))
        } else {
            Label(attachment.mime, systemImage: "doc")
                .font(.footnote)
        }
    }
}
