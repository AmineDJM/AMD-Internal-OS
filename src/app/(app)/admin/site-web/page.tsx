import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CheckCircle2, Circle, ExternalLink, FileText, ShieldAlert } from "lucide-react";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ADMIN_TABS } from "@/lib/labels";
import { formatDateTime } from "@/lib/utils";
import { etatIntegration, etatLiaison, etatReprise } from "@/lib/site-web/etat";
import { blocEnvironnement, cleEnAttente, origineDeLERP } from "@/lib/site-web/cles";
import { peutGererLaLiaison } from "@/lib/site-web/acces";
import { GesteIntegration } from "@/components/site-web/gestes-integration";
import { BlocCle } from "@/components/site-web/bloc-cle";
import { InfoBulle } from "@/components/ui/info-bulle";
import { dernierEvenementRecu } from "@/lib/site-web/audience-collecte";
import { ilYA } from "@/lib/site-web/audience-calc";
import { CarteLiaison } from "./carte-liaison";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Site web — connexion · Administration" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADMINISTRATION › SITE WEB — LA CONNEXION AU SITE PUBLIC (§118.159, §118.160). Super Admin SEUL.
 *
 * POURQUOI ICI, ET PLUS DANS LE MODULE « SITE WEB ». Le module est tenu par ceux qui PUBLIENT — la
 * Direction, la Direction Marketing, les RH pour les offres. La liaison, elle, est une affaire de
 * clé : la générer, la coller dans l'environnement du site, vérifier qu'il la reconnaît, lever un
 * blocage. Ces gestes étaient montrés à tous les publiants et refusés à tous sauf un — des boutons
 * qu'une action refuse ne sont pas des boutons (§118.27). La décision est du dirigeant : « cette
 * partie ne doit être disponible que pour le Super Admin, dans la console d'administration ».
 *
 * LA PORTE EST LA PREMIÈRE LIGNE, avant toute lecture : l'état de la liaison et, plus bas, la clé
 * EN ATTENTE (qui ne publie encore rien, et que l'écran remontre pour qu'un bloc perdu avant le
 * collage ne fasse pas tout recommencer). Aucune autre page ne lit une clé.
 *
 * L'écran de publication (`/site-web`) garde ce que les publiants doivent savoir — la file, l'état
 * de chaque contenu, le rapprochement quotidien, et une phrase quand rien ne part — sans un geste de
 * liaison.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function AdminSiteWebPage() {
  const user = await requireUser();
  if (!peutGererLaLiaison(user)) redirect("/mon-espace");

  const [integ, liaison, reprise, dernierAudience] = await Promise.all([
    etatIntegration(), etatLiaison(), etatReprise(), dernierEvenementRecu().catch(sansBloquer("site-web-page.AdminSiteWebPage.dernierEvenementRecu", null)),
  ]);
  const { config, blocage, compteurs, dernier } = integ;
  // L'adresse de l'ERP est celle par laquelle il est RÉELLEMENT arrivé sur cet écran : c'est elle
  // que le site devra appeler pour livrer les candidatures, et d'où il chargera la mesure d'audience.
  const h = await headers();
  const erp = origineDeLERP(process.env, {
    hote: h.get("x-forwarded-host") ?? h.get("host"),
    proto: h.get("x-forwarded-proto"),
  });
  const baliseAudience = erp ? `<script src="${erp}/api/site-web/v1/audience.js" defer></script>` : null;
  // LE BLOC À COLLER.
  let bloc: string | null = null;
  if (liaison.attente) {
    const attente = await cleEnAttente();
    if (attente) bloc = blocEnvironnement({ cle: attente.cle, secret: attente.secret, erp });
  }
  const sante = liaison.sante;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Site web — connexion"
        description="La liaison entre l'ERP et le site public : la clé que l'ERP fabrique, ce que le site dit de lui-même, le rapprochement. Réservé au Super Admin."
      >
        <Link href="/site-web"><Button size="sm" variant="outline"><FileText className="h-4 w-4" /> Articles et offres d&apos;emploi</Button></Link>
      </PageHeader>
      <ModuleTabs tabs={ADMIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      {blocage && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex gap-2 text-sm">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="font-semibold text-destructive">Publication suspendue depuis le {formatDateTime(blocage.at)}</p>
              <p className="mt-1 break-words text-foreground">{blocage.motif}</p>
              <p className="mt-1 text-muted-foreground">Rien n&apos;est perdu : les envois attendent en file et repartiront dès que la configuration sera corrigée.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <GesteIntegration geste="verifier" />
            {!liaison.attente && (
              <GesteIntegration
                geste="generer"
                libelle="Générer une nouvelle clé"
                variante="primary"
                confirmation="Générer une nouvelle clé ? Vous collerez ensuite le bloc dans l'environnement du site : la publication reprend d'elle-même dès qu'il l'a."
              />
            )}
            <GesteIntegration geste="lever" variante="ghost" />
          </div>
        </div>
      )}

      <CarteLiaison config={config} blocage={blocage} liaison={liaison} bloc={bloc} />

      {/* ── Le dernier rapprochement, en une ligne : son détail vit avec les contenus ─────── */}
      <Card>
        <CardHeader><CardTitle>Rapprochement</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!dernier ? (
            <p className="text-muted-foreground">
              Aucun rapprochement encore : il a lieu chaque jour dès que le site est relié, et après chaque redémarrage du site — ou
              maintenant, avec « Rapprocher maintenant ».
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={dernier.ok ? "success" : "danger"} dot>{dernier.ok ? "Réussi" : "Échoué"}</Badge>
              <span>{formatDateTime(dernier.at)} · {dernier.declencheur === "MANUEL" ? "lancé à la main" : "automatique"}</span>
              {dernier.erreur && <span className={dernier.ok ? "text-warning" : "text-destructive"}>— {dernier.erreur}</span>}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Le détail (écarts repoussés, contenus inconnus de l&apos;ERP, adresses en conflit) se lit avec les contenus, dans{" "}
            <Link href="/site-web" className="text-primary underline">Site web › Publication</Link>.
          </p>
        </CardContent>
      </Card>

      {/* ── LA MESURE D'AUDIENCE (Direction, 07/10) — la balise à donner au développeur du site ─── */}
      <Card id="audience" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Mesure d&apos;audience
            {dernierAudience
              ? <Badge tone="success" dot>Dernier événement reçu {ilYA(dernierAudience)}</Badge>
              : <Badge tone="warning" dot>Jamais reçu</Badge>}
            <InfoBulle label="Ce que fait la balise">
              À placer une fois dans le gabarit commun du site (avant &lt;/body&gt;). Sans cookie : pages vues, clics (Postuler, téléphone,
              e-mail, WhatsApp, liens externes, téléchargements, éléments marqués data-adventum-track) et temps passé. Seule l&apos;origine du
              site est acceptée.
            </InfoBulle>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {baliseAudience
            ? <BlocCle bloc={baliseAudience} libelle="Copier la balise" />
            : <p className="text-muted-foreground">Adresse publique de l&apos;ERP inconnue : fixez APP_URL.</p>}
          <Link href="/site-web/audience" className="inline-flex items-center gap-1 text-primary hover:underline">
            Voir l&apos;audience <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </CardContent>
      </Card>

      {/* ── LA REPRISE DES CONTENUS DU SITE (§118.160) — ce qui est venu du site, et où ça en est ─── */}
      <Card>
        <CardHeader><CardTitle>Contenus repris du site</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Les articles écrits dans le dépôt du site, ses offres d&apos;exemple et les offres saisies dans son administration
            deviennent des contenus de l&apos;ERP : on les modifie et on les supprime depuis{" "}
            <Link href="/site-web" className="text-primary underline">Site web</Link>, comme les autres. La reprise se fait au
            rapprochement, et rien ne change pour le public au moment où elle a lieu.
          </p>
          {!reprise.depotLu && (
            <p>
              <span className="font-medium">Pas encore faite.</span> Elle a lieu au prochain rapprochement — toutes les heures tant
              qu&apos;elle n&apos;a pas eu lieu — ou maintenant, avec « Rapprocher maintenant ».
              {reprise.dernier?.impossible && <span className="mt-1 block text-warning">{reprise.dernier.impossible}</span>}
            </p>
          )}
          {reprise.lignes.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {reprise.lignes.map((l) => (
                <li key={l.id} className="flex flex-col gap-1 p-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0">
                    <span className="mr-2 text-xs text-muted-foreground">{ORIGINE_COURTE[l.origine] ?? l.origine}</span>
                    {l.lien
                      ? <Link href={l.lien} className="break-words font-medium hover:underline">{l.titre}</Link>
                      : <span className="break-words font-medium text-muted-foreground line-through">{l.titre}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {l.lien
                      ? `${l.publie ? "publié" : "brouillon"} · repris le ${formatDateTime(l.le)}`
                      : "supprimé dans l'ERP — reste caché sur le site"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {reprise.dernier && reprise.dernier.aCorriger.length > 0 && (
            <div>
              <p className="font-medium">À corriger avant que la version de l&apos;ERP ne remplace celle du site</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {reprise.dernier.aCorriger.map((c) => (
                  <li key={c.id}>
                    <Link href={c.nature === "POST" ? `/site-web/articles/${c.id}` : `/site-web/offres/${c.id}`} className="text-primary hover:underline">{c.titre}</Link>
                    <span className="text-muted-foreground"> — {c.raison}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {reprise.dernier && reprise.dernier.conflits.length > 0 && (
            <div>
              <p className="font-medium">Non repris</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {reprise.dernier.conflits.map((c) => <li key={c.titre}><span className="font-medium">{c.titre}</span> — {c.raison}</li>)}
              </ul>
            </div>
          )}
          {reprise.dernier?.rechargement && <p className="text-xs text-muted-foreground">{reprise.dernier.rechargement.message}</p>}
        </CardContent>
      </Card>

      {/* ── OÙ EN EST LA MISE EN SERVICE ? (§118.159) — chaque coche est LUE, jamais déclarée ─── */}
      <Card>
        <CardHeader><CardTitle>Mise en service</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            <Etape faite={config.configuree && !blocage}>
              Relier le site : cliquer « Générer la clé », puis coller le bloc affiché dans l&apos;environnement du site (Render).
              L&apos;ERP fabrique la clé lui-même — personne n&apos;a à l&apos;inventer ni à la recopier des deux côtés.
            </Etape>
            <Etape faite={sante && sante.statut === 200 ? sante.authentifie === true : null}>
              Le site reconnaît la clé de l&apos;ERP.
            </Etape>
            <Etape faite={sante && sante.statut === 200 ? sante.erpRelie : null}>
              Le site sait où envoyer les candidatures (ligne ERP_BASE_URL du bloc).
            </Etape>
            <Etape faite={config.configuree && !blocage && Boolean(integ.dernierReussi)}>
              Un premier rapprochement réussi : l&apos;ERP a comparé ce que le site détient à ce qu&apos;il veut qu&apos;il détienne.
            </Etape>
            <Etape faite={compteurs.enLigne > 0}>Une offre ou un article en ligne, confirmé par le site.</Etape>
            <Etape faite={sante && sante.statut === 200 && sante.stockageDeSecours !== null ? !sante.stockageDeSecours : null}>
              Facultatif : un disque permanent pour le site (offre payante de Render). Sans lui, le site recharge ses offres et ses
              articles depuis l&apos;ERP à chaque redémarrage — automatiquement, en quelques secondes.
            </Etape>
          </ol>
          {config.racine && (
            <a href={config.racine} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline">
              Ouvrir le site <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** D'où vient un contenu repris, en deux mots pour une liste (la phrase complète vit sur sa fiche). */
const ORIGINE_COURTE: Record<string, string> = {
  ARTICLE_DEPOT: "Article du dépôt",
  OFFRE_EXEMPLE: "Offre d'exemple",
  OFFRE_ADMIN: "Offre saisie sur le site",
};

/** Une étape de mise en service : faite (lue dans l'état), à faire, ou impossible à vérifier d'ici (`null`). */
function Etape({ faite, children }: { faite: boolean | null; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      {faite === true
        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Fait" />
        : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label={faite === null ? "Invérifiable d'ici" : "À faire"} />}
      <span className="min-w-0">
        {children}
        {faite === null && <span className="block text-xs text-muted-foreground">Pas encore lisible : le site ne l&apos;a pas encore dit à l&apos;ERP.</span>}
      </span>
    </li>
  );
}
