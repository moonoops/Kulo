import { describe, expect, it, vi } from "vitest";
import {
  extractDeviceJoinMatches,
  formatDeviceChatInvitation,
  formatDeviceInstallerInstructions,
  mayContainDeviceInvitation,
  parseDeviceJoinInput,
  parseStandaloneDeviceInvitation,
  redactDeviceInvitationText,
  SENSITIVE_TEXT_REDACTION,
} from "@kulo/protocol";

const hubUrl = "https://hub.example.test:7788";
const inviteToken = "synthetic-pairing-example-one";
const legacy = { hubUrl, inviteToken };
const invitation = { ...legacy, hubId: "hub-test-1", hubName: '工作室 "一号" Mac' };
const nativeText = formatDeviceChatInvitation(invitation);
const posix = "curl -fsSL '" + hubUrl + "/connect/install.sh' | sh -s -- '" + hubUrl + "' '" + inviteToken + "'";
const windows = "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing '" + hubUrl +
  "/connect/install.ps1').Content)) '" + hubUrl + "' '" + inviteToken + "'";
const instructions = [
  "请将这台设备接入现有 Kulo 主脑 " + hubUrl + "。确保 Node.js 22.19 或更新版本和 npm 可用，按系统运行下面的接入命令，验证设备在线，并打开安装程序输出的本机 Kulo 地址，确认能看到主脑的对话和任务。以后运行安装生成的 kulo 命令，默认连接这个主脑。",
  "", "macOS / Linux：", posix, "", "Windows PowerShell：", windows, "", "配对命令在十分钟内有效且只能使用一次。",
].join("\n");

describe("Kulo chat invitations", () => {
  it("round-trips a short, versioned invitation with a canonical origin and quoted name", () => {
    expect(nativeText).toBe('KULO-JOIN/1 ' + hubUrl + " " + inviteToken + ' hub-test-1 "工作室 \\"一号\\" Mac"');
    expect(formatDeviceChatInvitation({ ...invitation, hubUrl: "HTTPS://HUB.EXAMPLE.TEST:7788/" })).toBe(nativeText);
    expect(parseStandaloneDeviceInvitation("\r\n" + nativeText + "\r\n")).toEqual(invitation);
    expect(parseDeviceJoinInput(nativeText)).toEqual(invitation);

    const ipv6 = { ...invitation, hubUrl: "http://[2001:db8::1]:55141" };
    expect(parseStandaloneDeviceInvitation(formatDeviceChatInvitation(ipv6))).toEqual(ipv6);
  });

  it("keeps the issuing Hub's display name single-line and separates it from the credential", () => {
    for (const hubName of ["", "A\nB", "A\u202eB", inviteToken, "a".repeat(101)]) {
      const safe = formatDeviceChatInvitation({ ...invitation, hubName });
      expect(parseStandaloneDeviceInvitation(safe)?.hubName).toBe("hub.example.test");
    }
    const encoded = JSON.stringify(invitation.hubName);
    for (const badName of ['"A\\nB"', '"A\\u0000B"', '"A\u2066B"', JSON.stringify(inviteToken), '"unterminated']) {
      expect(parseStandaloneDeviceInvitation(nativeText.replace(encoded, badName))).toBeUndefined();
    }
    expect(parseStandaloneDeviceInvitation(nativeText.replace(invitation.hubId, inviteToken))).toBeUndefined();
    expect(() => formatDeviceChatInvitation({ ...invitation, hubId: "bad id" })).toThrow();
  });

  it("accepts only an HTTP(S) origin and the current wire version", () => {
    for (const invalid of [hubUrl + "/other", hubUrl + "?q=1", hubUrl + "#other", "ftp://hub.example.test",
      "https://user@hub.example.test", "http://hub.example.test:0", "https://hub.\nexample.test"]) {
      expect(() => formatDeviceChatInvitation({ ...invitation, hubUrl: invalid })).toThrow();
      expect(parseStandaloneDeviceInvitation(nativeText.replace(hubUrl, invalid))).toBeUndefined();
    }
    expect(parseStandaloneDeviceInvitation(nativeText.replace("KULO-JOIN/1", "KULO-JOIN/2"))).toBeUndefined();
    expect(parseStandaloneDeviceInvitation(nativeText.replace(inviteToken, "short"))).toBeUndefined();
  });

  it("recognizes the original installer commands and the complete legacy clipboard text byte for byte", () => {
    expect(formatDeviceInstallerInstructions(legacy)).toEqual({ command: posix, windowsCommand: windows, agentInstructions: instructions });
    for (const input of [posix, windows, instructions, instructions.replaceAll("\n", "\r\n")]) {
      expect(parseStandaloneDeviceInvitation(input)).toEqual(legacy);
      expect(parseDeviceJoinInput(input)).toEqual(legacy);
    }
  });

  it("keeps quoted invitations, explanations, snippets and multiple invitations in chat", () => {
    for (const payload of [nativeText, posix, windows, instructions]) {
      for (const discussion of [
        "帮我分析这条邀请\n" + payload, payload + "\n这是什么意思？", "> " + payload, "    " + payload,
        '“' + payload + '”', "~~~text\n" + payload + "\n~~~", payload + "\n" + payload,
      ]) expect(parseStandaloneDeviceInvitation(discussion)).toBeUndefined();
    }
    const otherUrl = "https://second.example.test";
    const modified = [
      posix.replace(hubUrl + "/connect", otherUrl + "/connect"),
      windows.replace(hubUrl + "/connect", otherUrl + "/connect"),
      instructions.replace(windows, windows.replace(inviteToken, inviteToken + "-second")),
      instructions.replace(hubUrl, otherUrl), instructions.replace("只能使用一次。", "说明。"),
      nativeText + ' "附加文字"', posix + " && echo complete", posix + "\n" + windows,
    ];
    for (const input of modified) expect(parseStandaloneDeviceInvitation(input)).toBeUndefined();
  });

  it("retains legacy settings inputs while only official clipboard formats trigger the chat action", () => {
    const bare = hubUrl + " " + inviteToken;
    const cli = "peer.mjs install --hub '" + hubUrl + "' --invite '" + inviteToken + "'";
    for (const input of [bare, cli]) {
      expect(parseStandaloneDeviceInvitation(input)).toBeUndefined();
      expect(parseDeviceJoinInput(input)).toEqual(legacy);
    }
    expect(parseDeviceJoinInput(hubUrl + "/", inviteToken)).toEqual(legacy);
    expect(() => parseDeviceJoinInput(nativeText + "\n" + nativeText)).toThrow();
  });
});

describe("invitation credential privacy", () => {
  it("prefilters serialized history with native, installer and quoted address credentials", () => {
    for (const text of [nativeText, posix, windows, instructions, "说明\n" + hubUrl + '\t"' + inviteToken + '"\n结束']) {
      expect(mayContainDeviceInvitation(text)).toBe(true);
      expect(mayContainDeviceInvitation(JSON.stringify({ text }))).toBe(true);
    }
    expect(mayContainDeviceInvitation(JSON.stringify({ attachment: hubUrl + "/notes", title: "比较更新记录" }))).toBe(false);
  });

  it("locates precise token spans in mixed quoted content and redacts bare echoes", () => {
    const longer = inviteToken + "-second";
    const next = formatDeviceChatInvitation({ ...invitation, inviteToken: longer });
    const source = ["请分析以下内容", "> " + nativeText, posix, windows, next, "原文 " + longer + " " + inviteToken].join("\n");
    const matches = extractDeviceJoinMatches(source);
    expect(matches.map((m) => source.slice(m.tokenStart, m.tokenEnd))).toEqual([inviteToken, inviteToken, inviteToken, longer]);
    expect(matches.every((m) => m.hubUrl === hubUrl)).toBe(true);
    const remember = vi.fn();
    const safe = redactDeviceInvitationText(source, remember);
    expect(safe).toBe(source.replaceAll(longer, SENSITIVE_TEXT_REDACTION).replaceAll(inviteToken, SENSITIVE_TEXT_REDACTION));
    expect(remember).toHaveBeenCalledTimes(1);
    expect(new Set(remember.mock.calls[0]![0])).toEqual(new Set([inviteToken, longer]));
    expect(redactDeviceInvitationText(safe, remember)).toBe(safe);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("redacts visible token slots even when the version or target is unusable", () => {
    for (const unusable of [
      nativeText.replace("KULO-JOIN/1", "KULO-JOIN/2"),
      nativeText.replace(hubUrl, hubUrl + "/copied-path"),
      posix.replaceAll(hubUrl, "bad-target"),
    ]) {
      expect(parseStandaloneDeviceInvitation(unusable)).toBeUndefined();
      expect(extractDeviceJoinMatches(unusable)).toEqual([]);
      expect(redactDeviceInvitationText(unusable)).toBe(unusable.replaceAll(inviteToken, SENSITIVE_TEXT_REDACTION));
    }
  });

  it("redacts an isolated address and token line without staging it or hiding ordinary prose", () => {
    const remember = vi.fn();
    const pair = "  " + hubUrl + " '" + inviteToken + "' \r\n";
    const block = "接入信息\n" + pair + "结束";
    expect(redactDeviceInvitationText(block, remember)).toBe(block.replace(inviteToken, SENSITIVE_TEXT_REDACTION));
    expect(extractDeviceJoinMatches(block)).toEqual([]);
    expect(remember).toHaveBeenCalledTimes(1);
    for (const ordinary of [
      "查阅 " + hubUrl + " " + inviteToken, hubUrl + " " + inviteToken + " 在文档中", hubUrl + "/path " + inviteToken,
      inviteToken, "普通消息",
    ]) expect(redactDeviceInvitationText(ordinary, remember)).toBe(ordinary);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("finds an embedded invitation beyond the first megabyte of pasted text", () => {
    const text = "a".repeat(1_000_001) + "\n> " + nativeText;
    expect(redactDeviceInvitationText(text)).toBe(text.replace(inviteToken, SENSITIVE_TEXT_REDACTION));
  });
});
