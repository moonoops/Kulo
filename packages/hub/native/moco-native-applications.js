// This script is embedded in the signed helper. Requests are data, never script source.
function moco(requestJSON) {
  "use strict";
  var failureMarker = {};
  try {
  var request = JSON.parse(requestJSON);
  var p = request.params || {};
  var app = Application(request.bundleId);
  function fault(code) { throw { mocoMarker: failureMarker, code: code }; }
  function bounded(value, length) { return String(value === null || value === undefined ? "" : value).slice(0, length); }
  function date(value) { var parsed = new Date(value); return isNaN(parsed.getTime()) ? null : parsed.toISOString(); }
  function enabledAccounts() {
    var result = [], accounts = app.accounts;
    for (var index = 0; index < Math.min(accounts.length, 50); index++) {
      var account = accounts[index];
      if (!account.enabled()) continue;
      if (request.appId === "messages") {
        if (String(account.connectionStatus()).toLowerCase() !== "connected") continue;
        result.push(account);
      } else if (account.emailAddresses().length > 0) result.push(account);
    }
    if (result.length === 0) fault("connection_app_account_unavailable");
    return result;
  }
  var accounts = enabledAccounts();
  if (request.appId === "messages") {
    if (request.action === "probe") return JSON.stringify({ authorized: true, accountReady: true, username: bounded(accounts[0].id(), 256) });
    if (request.action !== "messages.send") fault("connection_app_invalid_parameters");
    var target, service;
    if (p.chatId) {
      var chats = app.chats.whose({ id: p.chatId });
      if (chats.length !== 1) fault("connection_app_target_unavailable");
      target = chats[0];
      service = String(target.account().serviceType());
      if (p.service && p.service.toLowerCase() !== service.toLowerCase()) fault("connection_app_target_unavailable");
    } else {
      service = p.service || "iMessage";
      var selected = accounts.filter(function(account) { return String(account.serviceType()).toLowerCase() === service.toLowerCase(); });
      if (selected.length !== 1) fault("connection_app_target_unavailable");
      target = selected[0].participants.byName(p.to);
    }
    app.send(p.text, { to: target });
    return JSON.stringify({ accepted: true, delivery: "submitted", service: service, ...(p.chatId ? { chatId: p.chatId } : { to: p.to }) });
  }
  function accountInfo(account) { return { accountId: bounded(account.id(), 512), name: bounded(account.name(), 256), emailAddresses: account.emailAddresses().slice(0, 20).map(function(value) { return bounded(value, 320); }) }; }
  function mailbox() {
    var requested = p.mailbox || "inbox";
    var specials = { inbox: "inbox", drafts: "draftsMailbox", sent: "sentMailbox", trash: "trashMailbox", junk: "junkMailbox" };
    if (!p.account && Object.prototype.hasOwnProperty.call(specials, requested.toLowerCase())) return app[specials[requested.toLowerCase()]]();
    var boxes;
    if (p.account) {
      var matching = accounts.filter(function(account) { return String(account.id()) === p.account; });
      if (matching.length !== 1) fault("connection_app_account_unavailable");
      boxes = matching[0].mailboxes;
    } else boxes = app.mailboxes;
    var pieces = requested.split("/").filter(function(piece) { return piece.length > 0; });
    if (pieces.length === 0 || pieces.length > 16) fault("connection_app_mailbox_unavailable");
    var selected;
    for (var index = 0; index < pieces.length; index++) {
      var found = [];
      for (var b = 0; b < Math.min(boxes.length, 500); b++) {
        var name = String(boxes[b].name());
        if (name === pieces[index] || index === 0 && requested.toLowerCase() === "inbox" && ["inbox", "收件箱"].indexOf(name.toLowerCase()) !== -1) found.push(boxes[b]);
      }
      if (found.length !== 1) fault("connection_app_mailbox_unavailable");
      selected = found[0];
      if (index < pieces.length - 1) boxes = selected.mailboxes;
    }
    return selected;
  }
  function summary(message) { return { messageId: String(message.id()), subject: bounded(message.subject(), 2_000), sender: bounded(message.sender(), 1_024), receivedAt: date(message.dateReceived()), read: Boolean(message.readStatus()) }; }
  if (request.action === "probe") {
    var count = app.inbox().messages.length;
    if (typeof count !== "number" || !isFinite(count) || count < 0) fault("connection_app_mailbox_unavailable");
    var primary = String(app.primaryEmail() || accounts[0].emailAddresses()[0]);
    return JSON.stringify({ authorized: true, accountReady: true, readable: true, username: bounded(primary, 256) });
  }
  if (request.action === "mail.list") {
    var box = mailbox();
    var collection = p.unreadOnly ? box.messages.whose({ readStatus: false }) : box.messages;
    var result = [], total = collection.length;
    for (var index = 0; index < Math.min(total, p.limit); index++) result.push(summary(collection[index]));
    return JSON.stringify({ messages: result, hasMore: total > result.length, accounts: accounts.slice(0, 20).map(accountInfo) });
  }
  if (request.action === "mail.read") {
    var matches = mailbox().messages.whose({ id: Number(p.messageId) });
    if (matches.length !== 1) fault("connection_app_mailbox_unavailable");
    var message = matches[0], body = String(message.content());
    return JSON.stringify({ message: Object.assign(summary(message), { body: body.slice(0, 32_000), truncated: body.length > 32_000 }) });
  }
  if (request.action !== "mail.draft" && request.action !== "mail.send") fault("connection_app_invalid_parameters");
  if (p.sender && !accounts.some(function(account) { return account.emailAddresses().some(function(value) { return String(value).toLowerCase() === p.sender.toLowerCase(); }); })) fault("connection_app_account_unavailable");
  var draft = app.OutgoingMessage({ subject: p.subject, content: p.body, visible: false });
  app.outgoingMessages.push(draft);
  if (p.sender) draft.sender = p.sender;
  p.to.forEach(function(address) { draft.toRecipients.push(app.ToRecipient({ address: address })); });
  p.cc.forEach(function(address) { draft.ccRecipients.push(app.CcRecipient({ address: address })); });
  p.bcc.forEach(function(address) { draft.bccRecipients.push(app.BccRecipient({ address: address })); });
  var draftId = String(draft.id());
  if (request.action === "mail.draft") {
    draft.save();
    return JSON.stringify({ draftId: draftId, saved: true });
  }
  var accepted = app.send(draft);
  if (accepted !== true) fault(accepted === false ? "connection_app_send_rejected" : "connection_app_delivery_unknown");
  return JSON.stringify({ draftId: draftId, accepted: true, delivery: "submitted" });
  } catch (error) {
    if (error && error.mocoMarker === failureMarker) return JSON.stringify({ mocoError: error.code });
    throw error;
  }
}
