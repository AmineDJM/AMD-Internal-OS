import type { Metadata, Viewport } from "next";
import { METADONNEES_ADVENTUM_IA } from "./metadonnees";

/**
 * ADVENTUM IA — l'app installable (décision 0027, point 11). Sur `adventum-ia.onrender.com` (APP_MODE=adventum-ia),
 * la racine y mène ; sur l'ERP, `/ia` l'ouvre aussi. Manifeste, icônes et écran de démarrage vivent dans
 * `public/adventum-ia/` : la charte de la Direction les remplace à l'identique de nom.
 */
export const metadata: Metadata = METADONNEES_ADVENTUM_IA;

/** La barre d'état et le cadre aux couleurs de l'app (le reste du viewport — `viewport-fit=cover` — vient de la racine). */
export const viewport: Viewport = {
  // UNE APP, PAS UNE PAGE (Direction, 31/10/2026 : « pas un truc que je peux tirer vers la droite, vers la gauche ») :
  // ni zoom au pincement ni au double-tap ; le clavier REDIMENSIONNE l'écran (la saisie reste visible, rien ne glisse).
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#2c59a7" },
    { media: "(prefers-color-scheme: dark)", color: "#08111f" },
  ],
};

export default function AdventumIaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
