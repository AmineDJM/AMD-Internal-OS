import type { Metadata } from "next";

/** Les métadonnées de l'app Adventum IA (nom, manifeste, icônes, démarrage iPhone) — `/ia` et, en mode app, `/login`. */
export const METADONNEES_ADVENTUM_IA: Metadata = {
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
