import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { MARQUE_VUE_COOKIE } from "@/lib/vue-exacte-ui";
import { IdentiteProvider, GardeIdentite } from "@/components/layout/identite-vue";
import { userCan } from "@/lib/rbac";
import { moduleForPath } from "@/lib/labels";
import { reécriteLienNotification } from "@/lib/notifications/lien-actuel";
import { navigationFor } from "@/lib/nav-access";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileTabBar } from "@/components/layout/mobile-tabbar";
import { ActivityTracker } from "@/components/layout/activity-tracker";
import { SessionRecorder } from "@/components/layout/session-recorder";
import { FocusExit } from "@/components/layout/focus-mode";
import { ScreenGuard } from "@/components/layout/screen-guard";
import { CommandPalette } from "@/components/layout/command-palette";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";
import { TestModeBanner } from "@/components/layout/test-mode-banner";
import { InterimBanner } from "@/components/layout/interim-banner";
import { ChromeMetrics } from "@/components/layout/chrome-metrics";
import { PushRegister } from "@/components/layout/push-register";
import { NotificationChime } from "@/components/layout/notification-chime";
import { NotificationPopup } from "@/components/layout/notification-popup";
import { UploadProvider } from "@/components/layout/upload-manager";
import { BackgroundUploadProvider } from "@/components/layout/background-upload";
import { CallProvider } from "@/components/layout/call-provider";
import { realtimeVoiceConfigured, canUseRealtimeVoice } from "@/lib/assistant/voice-realtime";
import { getTotalUnread } from "@/lib/queries/messaging";
import { getAdoptionBadge } from "@/lib/adoption";
import { aiConfigured, sttConfigured } from "@/lib/ai";
import { getMyCompanies, myCompanyScope } from "@/lib/company";
import { isTestUser } from "@/lib/features";
import { prisma } from "@/lib/prisma";
import { APP_SCROLL_ID } from "@/lib/use-scroll-lock";
import { NavDepthTracker } from "@/components/shared/back-link";
import { NavProgress } from "@/components/layout/nav-progress";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/change-password");
  // Onboarding guidé : lecture à chaud (BDD) plutôt que via le JWT — la fin du
  // parcours prend effet immédiatement, sans forcer une reconnexion.
  if (!user.impersonatedBy) {
    const flags = await prisma.user.findUnique({
      where: { id: user.id },
      select: { mustOnboard: true },
    });
    if (flags?.mustOnboard) redirect("/onboarding");
  }
  // CE QUE CETTE PERSONNE A LE DROIT D'OUVRIR — droits de module, masquages d'administration,
  // gardes supplémentaires et onglets, résolus ensemble dans `lib/nav-access`. Le calcul vivait
  // ici ; il a été sorti pour que le bureau d'Adam, qui n'a PAS cette coque, puisse offrir la
  // même liste sans la recopier — deux copies auraient divergé à la première garde ajoutée.
  const navItems = await navigationFor(user);
  const canMessage = userCan(user, "MESSAGING", "VIEW");
  const [unreadCount, messagingUnread, adoption, companies, unreadNotifs] = await Promise.all([
    prisma.notification.count({ where: { userId: user.id, isRead: false } }),
    canMessage ? getTotalUnread(user.id) : Promise.resolve(0),
    // Pastille « score d'adoption » de l'utilisateur courant (snapshot mis en cache).
    getAdoptionBadge(user.id, user.role).catch(() => null),
    // Entités du sélecteur : SEULEMENT celles auxquelles cette personne a droit. Proposer
    // toutes les sociétés du groupe reviendrait à laisser basculer vers les dossiers d'une
    // entité qui ne la regarde pas.
    getMyCompanies(user.id).catch(() => []),
    // Notifications non lues (leur lien) → badge par module dans le menu.
    prisma.notification.findMany({ where: { userId: user.id, isRead: false, link: { not: null } }, select: { link: true }, take: 500 }),
  ]);
  // Portée VALIDÉE contre les droits : le cookie est une demande, pas une autorisation.
  const companyScope = await myCompanyScope(user.id);
  // Mode test : la personne voit des nouveautés non encore validées en production.
  const testMode = await isTestUser(user.id).catch(() => false);
  // Compte les notifications non lues par MODULE (routées via leur lien) → badges de menu.
  const moduleBadges: Record<string, number> = {};
  for (const n of unreadNotifs) {
    // L'adresse ACTUELLE (une notification d'hier porte peut-être un module renommé) : le badge va
    // sur le module où le clic mènera, pas sur celui qui n'existe plus.
    const lien = reécriteLienNotification(n.link);
    const m = lien ? moduleForPath(lien) : null;
    if (m) moduleBadges[m] = (moduleBadges[m] ?? 0) + 1;
  }

  // LE TÉMOIN DE VUE TEL QUE CE RENDU L'A VU : la garde d'identité de l'onglet le compare au témoin actuel et
  // recharge tout s'il a changé ailleurs (autre onglet, expiration) — jamais une coque d'une personne au-dessus
  // d'une page d'une autre (Direction, 06/10).
  const marqueVue = cookies().get(MARQUE_VUE_COOKIE)?.value ?? "";

  return (
    <IdentiteProvider id={user.id} vue={Boolean(user.impersonatedBy)}>
    <GardeIdentite marque={marqueVue} />
    <UploadProvider>
    <BackgroundUploadProvider>
    {/* L'APPEL VIT AU NIVEAU DU LAYOUT, pas de la page Chief of Staff : naviguer dans l'ERP
        pendant un appel ne démonte pas la session WebRTC — la conversation continue. */}
    <CallProvider enabled={realtimeVoiceConfigured() && canUseRealtimeVoice(user)}>
    {/* LA COQUE EST UN BLOC CONTENEUR (`relative`) — c'est ce qui l'empêche de laisser le DOCUMENT défiler.
        Un élément `absolute` sans ancêtre positionné a pour bloc conteneur la FENÊTRE : le `overflow-hidden`
        de la coque ne le coupe pas, et son abscisse de repli (un `sr-only`, une pastille, un témoin de
        formulaire planté au bas d'une longue fiche) étendait le document à 2 025 px dans une fenêtre de
        1 080. Le document devenait défilable — et à la navigation suivante, Next appelle `scrollIntoView` sur
        le premier élément de la page : la FENÊTRE défilait de la hauteur de l'en-tête, qui disparaissait, et
        une bande blanche de la même hauteur apparaissait en bas (la capture de la Direction, 05/10/2026). */}
    <div className="relative flex h-screen overflow-hidden bg-background" data-app-shell>
      {/* Le fil de progression d'une navigation — SANS `loading.tsx` : une frontière Suspense
          au-dessus des pages transformerait chaque `redirect()` en redirection côté navigateur,
          qui casse en production sur Next 14.2 (voir `nav-progress.tsx`). */}
      <NavProgress />
      <ActivityTracker />
      {/* LE REJEU DE SESSION — pour le support technique : rembobiner la suite des actions et
          voir où ça a bugué. Aucune valeur de champ n'est lue ; les champs sensibles sont
          écartés entièrement. La divulgation aux salariés relève du règlement intérieur. */}
      <SessionRecorder />
      {/* Bouton flottant « quitter le plein écran » — hors du chrome qu'on replie. */}
      <FocusExit />
      {/* Compte les navigations internes : c'est ce qui permet aux liens « Retour » de remonter
          la page précédente au lieu de renvoyer à la racine du module. */}
      <NavDepthTracker />
      <ScreenGuard />
      <CommandPalette navItems={navItems} />
      <Sidebar items={navItems} messagingUnread={messagingUnread} moduleBadges={moduleBadges} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Tout ce qui surmonte la zone de contenu est MESURÉ ensemble : les bandeaux passent à
            la ligne sur un écran étroit, et les écrans pleine hauteur doivent déduire la
            hauteur réelle, pas une estimation. */}
        <ChromeMetrics>
          {user.impersonatedBy && <ImpersonationBanner viewedName={user.name} />}
          {testMode && <TestModeBanner />}
          {/* L'intérimaire voit qu'il agit au nom de quelqu'un — calculé par `getAccess`, aucune lecture de plus (§118.196). */}
          {user.access.interims && user.access.interims.length > 0 && <InterimBanner interims={user.access.interims} />}
          <Topbar navItems={navItems} user={{ name: user.name, email: user.email, role: user.role, enVue: Boolean(user.impersonatedBy) }} unreadCount={unreadCount} canMessage={canMessage} messagingUnread={messagingUnread} adoption={adoption} companies={companies} companyScope={companyScope} />
        </ChromeMetrics>
        {/* `page-shell` porte les règles « pleine largeur sur téléphone » (globals.css) :
            les cartes de premier niveau y perdent leurs bordures latérales pour occuper
            tout l'écran, comme dans une application native.

            `id` : c'est CE conteneur qui défile (la coque est `overflow-hidden`). Les couches
            modales le verrouillent par cet identifiant — verrouiller le `body` ne ferait rien. */}
        {/* `overflow-x-hidden` — LA CAUSE DU « ça glisse trop ».
            `overflow-y: auto` seul ne suffit pas : en CSS, un axe en `auto` force l'autre à
            devenir défilant. Ce conteneur défilait donc AUSSI latéralement, et le moindre
            tableau trop large faisait partir toute la page de travers, en-tête compris — on
            « tirait l'écran vers la gauche » pour lire une colonne.
            En le bornant, le contenu large doit défiler DANS SON PROPRE conteneur
            (`overflow-x-auto`), ce que `src/lib/responsive-guard.test.ts` vérifie fichier par
            fichier. `overscroll-contain` complète le geste : le rebond en fin de liste ne
            remonte plus jusqu'à la page hôte, comme dans une application native. */}
        <main
          id={APP_SCROLL_ID}
          className="relative flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-[calc(5.5rem+env(safe-area-inset-bottom))] pl-[calc(0.75rem+env(safe-area-inset-left))] pr-[calc(0.75rem+env(safe-area-inset-right))] pt-3 sm:pl-[calc(1rem+env(safe-area-inset-left))] sm:pr-[calc(1rem+env(safe-area-inset-right))] sm:pt-6 lg:px-8 lg:pb-8"
        >
          {/* La largeur du contenu est PLAFONNÉE par défaut : au-delà, une ligne de texte devient
              illisible parce que l'œil perd le début de la suivante. Mais un tableau de treize
              colonnes, lui, a besoin de toute la place — d'où la variable, qu'un écran dense
              peut relever pour lui seul. */}
          <div
            className="page-shell mx-auto space-y-4 sm:space-y-6"
            style={{ maxWidth: "var(--shell-max, 1400px)" }}
          >
            {children}
          </div>
        </main>
      </div>
      {/* Navigation MOBILE : barre d'onglets basse + grille complète des modules. */}
      <MobileTabBar items={navItems} messagingUnread={messagingUnread} moduleBadges={moduleBadges} />
      {/* Notifications push (PWA) : enregistre le service worker + (ré)abonne l'appareil. */}
      <PushRegister />
      {/* Sonnerie de rappel/notification (carillon) + notification bureau à l'arrivée. */}
      <NotificationChime initial={unreadCount} />
      {/* Notifications pop-up plein écran (grande fenêtre centrée) diffusées depuis l'Administration. */}
      <NotificationPopup />
    </div>
    </CallProvider>
    </BackgroundUploadProvider>
    </UploadProvider>
    </IdentiteProvider>
  );
}
