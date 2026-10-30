import type { Metadata, Viewport } from "next";

/**
 * ADVENTUM IA — l'app installable (décision 0027, point 11). Sur `adventum-ia.onrender.com` (APP_MODE=adventum-ia),
 * la racine y mène ; sur l'ERP, `/ia` l'ouvre aussi. Manifeste, icônes et écran de démarrage vivent dans
 * `public/adventum-ia/` : la charte de la Direction les remplace à l'identique de nom.
 */
export const metadata: Metadata = {
  title: "Adventum IA",
  description: "L'assistant d'Adventum Pharma — le même que dans l'ERP, avec vos droits.",
  applicationName: "Adventum IA",
  manifest: "/adventum-ia/manifest.webmanifest",
  icons: {
    icon: [{ url: "/adventum-ia/icone-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/adventum-ia/icone-180.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "Adventum IA",
    statusBarStyle: "black-translucent",
    startupImage: [
      { url: "/adventum-ia/demarrage-1170x2532.png", media: "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)" },
      { url: "/adventum-ia/demarrage-1179x2556.png", media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" },
      { url: "/adventum-ia/demarrage-1290x2796.png", media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" },
    ],
  },
  other: { "mobile-web-app-capable": "yes" },
};

/** La barre d'état et le cadre aux couleurs de l'app (le reste du viewport — `viewport-fit=cover` — vient de la racine). */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#2c59a7" },
    { media: "(prefers-color-scheme: dark)", color: "#08111f" },
  ],
};

export default function AdventumIaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
