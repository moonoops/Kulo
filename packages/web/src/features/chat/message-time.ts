const pad = (value: number) => String(value).padStart(2, "0");

export function formatMessageTime(createdAt: number | undefined, now = new Date()): { label: string; title: string; dateTime: string } | undefined {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  const year = date.getFullYear();
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = year === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const offset = -date.getTimezoneOffset();
  const zone = `UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return {
    label: sameDay ? time : `${year === now.getFullYear() ? "" : `${year}-`}${day} ${time}`,
    title: `${year}-${day} ${time}:${pad(date.getSeconds())} ${zone}`,
    dateTime: date.toISOString(),
  };
}
