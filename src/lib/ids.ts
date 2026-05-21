import { customAlphabet } from "nanoid";

const urlSafe = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const newSessionId = customAlphabet(urlSafe, 40);
export const newShareToken = customAlphabet(urlSafe, 32);
export const newEventUid = customAlphabet(urlSafe, 22);
export const newInvitationToken = customAlphabet(urlSafe, 32);
