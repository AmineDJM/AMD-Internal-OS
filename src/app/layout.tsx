import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

/**
 * INTER — dessinée pour les interfaces denses : hauteur d'x généreuse, chiffres tabulaires,
 * aucune ambiguïté entre 1, l et I sur une référence de dossier. Servie par `next/font`,
 * donc auto-hébergée : pas de requête vers un CDN au chargement, et aucun saut de police.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "AMD Internal OS — Adventum Pharma",
  description:
    "Logiciel interne centralisé pour la gestion des pôles Regulatory, Sponsoring, Budgets, Congrès, Ventes, Logistique PCH, Promotion médicale et Business Development d'Adventum Pharma.",
  applicationName: "AMD Internal OS",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  // Confort mobile : ressemble à une app installée, n'altère pas numéros/dates.
  appleWebApp: { capable: true, statusBarStyle: "default", title: "AMD OS" },
  formatDetection: { telephone: false, date: false, address: false, email: false },
};

// `viewport-fit=cover` est requis pour que `env(safe-area-inset-*)` fonctionne
// (encoche iPhone, barres Android) — sinon la bulle flottante et les barres collées
// seraient mal placées. `width=device-width` garantit un rendu mobile correct.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr" className={inter.variable} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
