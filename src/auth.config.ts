import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe base config shared between the middleware (edge runtime) and the
 * full Node config in `auth.ts`. It must NOT import Prisma or bcrypt.
 */
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [], // real providers are added in auth.ts (Node runtime)
  callbacks: {
    // Route protection. Runs in middleware on every matched request.
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnLogin = nextUrl.pathname.startsWith("/login");

      // Le portail fournisseur est EXTERNE : il a sa propre authentification
      // (cookie de session SupplierUser, vérifié au niveau page via requireSupplier).
      // Il ne doit jamais être soumis à l'auth interne NextAuth.
      if (nextUrl.pathname.startsWith("/portail")) return true;

      // Page publique d'inscription aux événements (lien partageable, sans compte)
      // + image QR publique (jeton non devinable ; le check-in lui-même reste protégé).
      if (nextUrl.pathname.startsWith("/inscription")) return true;
      if (nextUrl.pathname.startsWith("/api/events/qr")) return true;

      // Lien de réunion EXTERNE partageable (Jitsi) : invité sans compte, jeton non
      // devinable. La salle est gérée par Jitsi ; aucune donnée interne n'est exposée.
      if (nextUrl.pathname.startsWith("/meet/")) return true;

      // LE SITE PUBLIC appelle l'ERP (§118.159) : les candidatures déposées sur adventumdz.com, et
      // la relecture de ses contenus quand il redémarre. Il n'a pas de session — ces routes
      // vérifient ELLES-MÊMES sa clé et la signature du corps (`site-web/entrant.ts`), et un
      // cliquet exige que chacune le fasse avant tout le reste. Le préfixe est exact, barre finale
      // comprise : `/api/site-web/candidatures/…` (le CV servi aux RH) reste derrière la session.
      if (nextUrl.pathname.startsWith("/api/site-web/v1/")) return true;

      // LE DOCUMENT SERVER (OnlyOffice) lit le fichier et rappelle l'enregistrement SERVEUR À
      // SERVEUR, sans session : derrière la connexion, il recevait la page /login et l'éditeur
      // disait « erreur de téléchargement ». Ces deux routes vérifient ELLES-MÊMES le jeton signé
      // (`readFileReadToken` / `readDocReadToken` ; `lireRappelOnlyoffice` pour le rappel) avant toute lecture. Chemins exacts : `/session`
      // (qui émet ces jetons) reste derrière la connexion.
      if (nextUrl.pathname === "/api/onlyoffice/file" || nextUrl.pathname === "/api/onlyoffice/callback") return true;

      if (isOnLogin) {
        if (isLoggedIn) {
          return Response.redirect(new URL("/mon-espace", nextUrl));
        }
        return true; // allow the login page for anonymous users
      }

      // Everything else requires authentication.
      return isLoggedIn;
    },
  },
} satisfies NextAuthConfig;
