import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * LE TYPECHECK DU DÉPLOIEMENT VIT DANS SON PROPRE PROCESSUS — quelle que soit la commande de build.
 *
 * Intégré à `next build`, il consomme ~4,7 Go (Prisma + 730 K lignes) dans un tas de ~4 Go : le
 * déploiement Render mourait en « heap out of memory » à « Checking validity of types ». Le tableau
 * de bord Render lance un `npx next build` NU — pas `npm run build:render`, où le correctif aurait
 * pu vivre : un correctif qui dépend d'une commande qu'on ne contrôle pas ne corrige rien. Il vit
 * donc ICI, là où `next build` passe forcément.
 *
 * PAS un contournement : tsc tourne sur la PRODUCTION (`tsconfig.build.json`, sans les fichiers de
 * test — `npm run typecheck` les vérifie tous) avec un tas de 5 Go, AVANT la compilation ; la moindre
 * erreur de type ARRÊTE le build. Seul `next build` sur Render (variable `RENDER`) le fait : un build
 * local garde le typecheck intégré, et `next start` ne le déclenche jamais (autre phase).
 * `TYPECHECK_SEPARE` évite de le refaire dans les processus fils de la compilation.
 */
function typecheckSepare(phase) {
  if (process.env.TYPECHECK_SEPARE === "1") return true;
  if (phase !== "phase-production-build" || !process.env.RENDER) return false;
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  console.log("[build] Typecheck de la production dans son propre processus (tas : 5 Go)…");
  try {
    execFileSync(process.execPath, ["--max-old-space-size=5120", tsc, "--noEmit", "-p", "tsconfig.build.json"], { stdio: "inherit" });
  } catch {
    throw new Error("Typecheck en échec : le build est arrêté (les erreurs de type sont affichées ci-dessus).");
  }
  process.env.TYPECHECK_SEPARE = "1";
  return true;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // PAS un contournement : le lint tourne en PHASE SÉPARÉE et BLOQUANTE du build de
    // déploiement (`npm run build:render` → `next lint && next build`). Le faire tourner une
    // seconde fois DANS `next build` additionnait ~1 Go (ESLint) aux ~1,4 Go du typecheck
    // (Prisma : 560 K lignes de définitions) dans le MÊME processus Node → OOM à la limite
    // par défaut de 2 Go sur Render (« Ineffective mark-compacts near heap limit »). Le
    // typecheck, lui, reste DANS le build (`typescript.ignoreBuildErrors` n'est PAS touché).
    ignoreDuringBuilds: true,
  },
  experimental: {
    // ── MÉMOIRE DE BUILD : borner le PARALLÉLISME, pas la fonctionnalité ──────────────
    //
    // Mesuré sur un build propre (4 vCPU, échantillonnage RSS de l'arbre node) :
    //   compilation webpack …… pic 4612 Mo (1 processus à 4491)
    //   typecheck tsc ………………… pic 2692 Mo (phase distincte, jamais simultanée)
    //   génération statique …… pic 3924 Mo = parent 2005 + 3 workers à ~550 Mo
    //
    // Le piège : Next dimensionne ses workers sur le NOMBRE DE CŒURS de la machine de
    // build. Ici 4 cœurs → 3 workers → 3,9 Go. Sur un builder Render à 8 ou 16 vCPU, la
    // même étape réclame 2005 + 7×550 ≈ 5,9 Go, voire ≈ 10 Go — d'où le « Ran out of
    // memory (used over 8GB) » que la machine de développement ne reproduit jamais.
    // Le pic ne dépendait donc pas du code mais du matériel : on le BORNE.
    //
    // `cpus` plafonne les workers de collecte/génération de pages, rendant le pic
    // INDÉPENDANT du builder.
    //
    // 10/2026 — UN SEUL worker. Le code a grossi : chaque worker de génération charge les
    // bundles serveur de ses pages et pèse désormais ~1,7 Go (et non plus ~550 Mo). Mesuré
    // sur un build propre (RENDER=1, tas 3072) : 2 workers → pic 6817 Mo (parent 3094 +
    // 2×1,7 Go) — plus node_modules et .next dans le même conteneur, la ligne des 8 Go de
    // Render est franchie ; 1 worker → 5437 Mo. Le dernier déploiement réussi (b24eb0c)
    // était déjà à 6256 Mo : la marge avait disparu. Coût : la génération des pages (presque
    // toutes dynamiques, donc rapides) n'est plus parallèle — quelques secondes.
    cpus: 1,
    // Chaque compilation (serveur, client, edge) tourne dans son propre processus, qui
    // MEURT ensuite : la mémoire retourne à l'OS au lieu de s'accumuler dans un seul tas
    // pour les trois. C'est ce qui plafonne le pic de la phase de compilation.
    webpackBuildWorker: true,
    // LE PLUS GROS LEVIER MESURÉ : −1034 Mo sur le pic (4548 → 3514) et −127 s de
    // compilation. Le pic tombait en FIN de compilation — signature de la minification.
    //
    // Ce qu'on abandonne : les bundles SERVEUR (jamais téléchargés par le navigateur)
    // restent non minifiés, donc plus gros sur le disque et un démarrage à froid
    // marginalement plus lent. Ce qu'on garde intact : la minification CLIENT — les
    // bundles réellement servis au navigateur — et tout le reste du comportement.
    // Aucune vérification n'est désactivée, aucune fonctionnalité retirée.
    serverMinification: false,
    // Libs Node serveur uniquement (jamais bundlées côté client) : auth, mail (IMAP/SMTP),
    // extraction/OCR (tesseract.js/mupdf/sharp = WASM/natif, à ne pas bundler).
    // `pdfkit` (conversion des fiches de paie Word → PDF) lit ses MÉTRIQUES DE POLICES depuis des
    // fichiers `.afm` livrés dans le paquet. Bundlé, ces fichiers ne suivent pas : la conversion
    // marcherait en développement et échouerait en production — le pire des deux mondes.
    serverComponentsExternalPackages: ["bcryptjs", "imapflow", "nodemailer", "mailparser", "pdf-parse", "mammoth", "xlsx", "tesseract.js", "mupdf", "sharp", "docxtemplater", "pizzip", "pdfkit"],
    // Téléversements via Server Action (documents Regulatory/Congrès/Dossiers…) : Next
    // plafonne le corps à 1 Mo par défaut, ce qui rendait inopérante la limite réglée par
    // l'admin. On lève ce plafond à 256 Mo ; la VRAIE limite reste celle définie par le
    // Super Admin (AppSetting → validateUpload). Les très gros fichiers passent par le Drive
    // (routes en flux, jusqu'à la limite Drive configurée).
    serverActions: { bodySizeLimit: "256mb" },
  },
  // ── PAS DE TRAÇAGE DES FICHIERS (`.nft.json`) ─────────────────────────────────────────
  //
  // Next 14 trace, pour chaque page, les fichiers dont elle dépend — DANS le processus
  // parent, PENDANT la génération des pages : c'est ce qui porte le parent à ~3 Go au pic.
  // Ces traces ne servent qu'à `output: "standalone"` (copier le strict nécessaire dans une
  // image). Render lance `next start` sur le dépôt complet, node_modules compris : il ne
  // les lit jamais. Aucune vérification, aucune fonctionnalité n'en dépend.
  outputFileTracing: false,
  // ── LE CACHE WEBPACK NE VIT PLUS EN ENTIER DANS LE TAS ─────────────────────────────────
  //
  // En production, Next règle le cache filesystem de webpack sur `maxMemoryGenerations:
  // Infinity` : CHAQUE entrée du cache (984 Mo sérialisés sur ce dépôt) reste AUSSI en
  // mémoire du compilateur jusqu'à la fin — et le fichier s'écrit NON compressé. Sur le
  // conteneur de build Render, tout compte dans le MÊME plafond de 8 Go : les processus
  // node (~3,9 Go mesurés) PLUS les fichiers du workspace (node_modules 1,1 Go, cache npm,
  // .next 1,1 Go dont 984 Mo de cache webpack). Un build à cache FROID franchit la ligne ;
  // à cache chaud il passe — c'est pourquoi le même commit réussissait puis échouait.
  //
  // `maxMemoryGenerations: 1` (exactement ce que fera le drapeau officiel
  // `webpackMemoryOptimizations` de Next 15) : une entrée non réutilisée est évacuée du tas
  // à la génération suivante — le cache DISQUE reste complet, seuls les doublons en mémoire
  // disparaissent. Sur Render (`process.env.RENDER`), le fichier est de plus COMPRESSÉ
  // (gzip ≈ ⅓ de la taille) : moins d'octets dans le conteneur, cache inter-déploiements
  // conservé. Aucune vérification désactivée, aucun contenu de cache perdu.
  webpack: (config) => {
    if (config.cache && config.cache.type === "filesystem") {
      config.cache.maxMemoryGenerations = 1;
      if (process.env.RENDER) config.cache.compression = "gzip";
    }
    return config;
  },
  // Security headers applied to every response.
  async headers() {
    // CSP volontairement ciblée sur les directives à fort impact ET sans risque
    // de casse : on NE restreint PAS script-src/style-src/connect-src (Next.js
    // injecte des scripts/styles inline ; l'éditeur OnlyOffice charge son api.js
    // et s'affiche en iframe ; l'aperçu e-mail/PDF utilise blob:/data:). On bloque
    // en revanche le clickjacking, les plugins, l'injection de <base> et le
    // détournement de formulaires, et on force HTTPS.
    const csp = [
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          // SAMEORIGIN (et non DENY) : protège du clickjacking cross-origin tout en
          // autorisant l'app à embarquer ses propres fichiers (aperçu PDF in-app).
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // `self` (et non liste vide) : autorise micro (rapports vocaux), caméra
            // (scan QR check-in) et géolocalisation pour NOTRE origine uniquement.
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=(self)",
          },
          { key: "Content-Security-Policy", value: csp },
          // Force HTTPS pendant 2 ans (Render sert en HTTPS) — anti-downgrade / MITM.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          // Isolation des fenêtres (anti-XS-Leaks / tabnabbing).
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
        ],
      },
    ];
  },
};

export default (phase) => ({
  ...nextConfig,
  typescript: { ignoreBuildErrors: typecheckSepare(phase) },
});
