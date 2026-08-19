'use strict';
// Applies the upstream fix from wwebjs/whatsapp-web.js PR #201850
// (issue #201845: "Client.getState() and Client.getChats() throws r: r")
// to the installed copy of src/util/Injected/Utils.js.
//
// WhatsApp Web 2.3000.104xxx renamed `_serialized` -> `$1` on message keys and
// migrated contacts to the LID system, which made `getChats()`/`getChatById()`
// throw minified `r: r` errors whenever any group chat failed to serialize.
// Safe to re-run: every replacement is asserted to occur exactly once.

const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('usage: node apply-wwebjs-fix.js <Utils.js>'); process.exit(2); }

let src = fs.readFileSync(path, 'utf8');

const edits = [
  {
    name: 'sendMessage: Msg.get(newMsgKey)',
    from: `            .Msg.get(newMsgKey._serialized);`,
    to:   `            .Msg.get(window.WWebJS.getMsgKeyId(newMsgKey));`,
  },
  {
    name: 'editMessage: Msg.get(msg.id)',
    from: `        return window.require('WAWebCollections').Msg.get(msg.id._serialized);`,
    to:   `        return window.require('WAWebCollections').Msg.get(window.WWebJS.getMsgKeyId(msg.id));`,
  },
  {
    name: 'getMessageModel: restore _serialized on msg.id',
    from: `        delete msg.pendingAckUpdate;`,
    to: `        // PR #201850: WhatsApp Web renamed \`_serialized\` to \`\$1\` on message
        // keys. Restore it so every consumer of \`message.id._serialized\` keeps
        // working instead of silently receiving \`undefined\`.
        if (typeof msg.id === 'object' && msg.id._serialized == null) {
            const serializedId = window.WWebJS.getMsgKeyId(msg.id);
            if (serializedId) {
                msg.id = Object.assign({}, msg.id, {
                    _serialized: serializedId,
                });
            }
        }

        delete msg.pendingAckUpdate;`,
  },
  {
    name: 'getMsgKeyId helper',
    from: `    window.WWebJS.getChats = async () => {`,
    to: `    /**
     * Serialized id of a message key, tolerating WhatsApp Web having renamed
     * \`_serialized\` to \`\$1\`. Falls back to \`undefined\` so callers can skip
     * IndexedDB lookups instead of hitting \`DataError: No key or key range
     * specified\`.
     */
    window.WWebJS.getMsgKeyId = (key) =>
        key?._serialized ?? key?.$1 ?? undefined;

    window.WWebJS.getChats = async () => {`,
  },
  {
    name: 'getChats: per-chat error isolation',
    from: `        const chatPromises = chats.map((chat) =>
            window.WWebJS.getChatModel(chat),
        );
        return await Promise.all(chatPromises);`,
    to: `        // Process each chat individually — one failure must not discard every
        // chat. Chats that fail to serialize (e.g. LID group metadata) are skipped.
        const results = [];
        for (const chat of chats) {
            try {
                const model = await window.WWebJS.getChatModel(chat);
                if (model) results.push(model);
            } catch {
                // skip chats that fail serialization
            }
        }
        return results;`,
  },
  {
    name: 'getChatModel: tolerate LID group metadata',
    from: `            await groupMetadata.update(chatWid);`,
    to: `            try {
                await groupMetadata.update(chatWid);
            } catch {
                // LID-based chat IDs may be missing from IndexedDB — skip group metadata
                model.groupMetadata = null;
            }`,
  },
  {
    name: 'getChatModel: lastReceivedKey via getMsgKeyId',
    from: `            const lastMessage = chat.lastReceivedKey
                ? window
                      .require('WAWebCollections')
                      .Msg.get(chat.lastReceivedKey._serialized) ||
                  (
                      await window
                          .require('WAWebCollections')
                          .Msg.getMessagesById([
                              chat.lastReceivedKey._serialized,
                          ])
                  )?.messages?.[0]
                : null;`,
    to: `            const lastReceivedKeyId = window.WWebJS.getMsgKeyId(
                chat.lastReceivedKey,
            );
            const lastMessage = lastReceivedKeyId
                ? window
                      .require('WAWebCollections')
                      .Msg.get(lastReceivedKeyId) ||
                  (
                      await window
                          .require('WAWebCollections')
                          .Msg.getMessagesById([lastReceivedKeyId])
                  )?.messages?.[0]
                : null;`,
  },
];

for (const e of edits) {
  const count = src.split(e.from).length - 1;
  if (count !== 1) {
    console.error(`FAIL [${e.name}]: expected 1 occurrence, found ${count}`);
    process.exit(1);
  }
  src = src.replace(e.from, e.to);
  console.log(`ok [${e.name}]`);
}

// Fix indent on the upstream getMessageModel block so boundaries stay aligned.
fs.writeFileSync(path, src, 'utf8');
console.log(
  '\nApplied all edits. New file has ' +
    src.split('\n').length +
    ' lines.',
);