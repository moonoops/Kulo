import type { ConnectionApplicationId, ConnectionCategory, ConnectionKind } from "@kulo/protocol";
import { KuloIcon } from "../../kulo-icon";

export function ConnectionIcon({ appId, kind, category }: { appId?: ConnectionApplicationId; kind?: ConnectionKind; category?: ConnectionCategory }) {
  return <span className={`kulo-connection-icon${appId ? ` kulo-connection-icon--${appId}` : ""}`} aria-hidden="true">
    {appId === "messages" ? <KuloIcon name="message" size={28} />
      : appId === "mail" ? <KuloIcon name="mail" size={28} />
      : appId === "github" ? <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .7a11.3 11.3 0 0 0-3.57 22.02c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.34-3.8-1.34-.5-1.3-1.25-1.65-1.25-1.65-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.73 2.65 1.23 3.3.94.1-.74.4-1.23.72-1.51-2.5-.28-5.14-1.25-5.14-5.59 0-1.23.44-2.24 1.17-3.03-.12-.29-.51-1.44.11-2.99 0 0 .96-.3 3.11 1.16a10.8 10.8 0 0 1 5.66 0c2.16-1.46 3.11-1.16 3.11-1.16.62 1.55.23 2.7.11 2.99a4.36 4.36 0 0 1 1.16 3.03c0 4.35-2.64 5.3-5.16 5.58.41.35.77 1.04.77 2.1v3.19c0 .3.2.65.78.54A11.3 11.3 0 0 0 12 .7Z" /></svg>
      : appId === "figma" ? <svg width="22" height="30" viewBox="0 0 20 30" fill="none"><path d="M5 30a5 5 0 0 0 5-5v-5H5a5 5 0 0 0 0 10Z" fill="#0ACF83" /><path d="M0 15a5 5 0 0 1 5-5h5v10H5a5 5 0 0 1-5-5Z" fill="#A259FF" /><circle cx="15" cy="15" r="5" fill="#1ABCFE" /><path d="M0 5a5 5 0 0 1 5-5h5v10H5a5 5 0 0 1-5-5Z" fill="#F24E1E" /><path d="M10 0h5a5 5 0 0 1 0 10h-5V0Z" fill="#FF7262" /></svg>
      : <KuloIcon name={category === "information" ? "document" : kind === "ssh" ? "terminal" : kind === "api-key" ? "code" : "key"} size={25} />}
  </span>;
}
