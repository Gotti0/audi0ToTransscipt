export interface Subtitle {
  startTime: string;
  endTime: string;
  text: string;
}

export function jsonToSrt(subtitles: Subtitle[]): string {
  return subtitles
    .map((sub, index) => {
      return `${index + 1}\n${sub.startTime} --> ${sub.endTime}\n${sub.text}\n`;
    })
    .join("\n");
}

export function downloadSrt(srtContent: string, filename: string) {
  const blob = new Blob([srtContent], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
