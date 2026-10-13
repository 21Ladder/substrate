// Mitgelieferte Titelbilder: Farbverläufe und Volltöne (keine externen Bilder nötig).

export const GRADIENTS = [
  "linear-gradient(135deg, #f6d365 0%, #fda085 100%)",
  "linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)",
  "linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)",
  "linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)",
  "linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)",
  "linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)",
  "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  "linear-gradient(135deg, #30cfd0 0%, #330867 100%)",
  "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
  "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
  "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
  "linear-gradient(135deg, #0c3483 0%, #a2b6df 100%)",
  "linear-gradient(160deg, #1e3c72 0%, #2a5298 100%)",
  "linear-gradient(160deg, #134e5e 0%, #71b280 100%)",
  "linear-gradient(160deg, #3a1c71 0%, #d76d77 50%, #ffaf7b 100%)",
  "linear-gradient(160deg, #232526 0%, #414345 100%)",
];

export const SOLIDS = ["#e03e3e", "#ffa344", "#ffdc49", "#4dab9a", "#529cca", "#9a6dd7", "#e255a1", "#9b9a97", "#2f3437", "#f1f1ef"];

export function coverBackground(cover: string | null | undefined): string | null {
  if (!cover) return null;
  if (cover.startsWith("gradient:")) return GRADIENTS[Number(cover.slice(9)) % GRADIENTS.length] ?? null;
  if (cover.startsWith("color:")) return /^#[0-9a-f]{3,8}$/i.test(cover.slice(6)) ? cover.slice(6) : null;
  // Nur lokale Bilder; externe Titelbilder werden beim Festlegen heruntergeladen
  if (/^(app:\/\/asset\/|data:image\/)/.test(cover)) return `url("${cover.replace(/["\\\n\r]/g, "")}")`;
  return null;
}

export function randomCover(): string {
  return `gradient:${Math.floor(Math.random() * GRADIENTS.length)}`;
}
