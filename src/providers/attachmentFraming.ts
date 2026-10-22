// Re-export: the framing lives in `src/shared` so admission and dispatch can
// price exactly the text the adapters send.
export {
  frameAttachmentOnlyNote,
  frameExtractedAttachment,
  frameNativeAttachmentNotice,
  UNTRUSTED_ATTACHMENT_CONTENT_NOTICE,
} from "../shared/attachmentFraming.js";
