import Link from "next/link";
import { AlertTriangle, ExternalLink, FileText, Briefcase, KeyRound, ShieldAlert } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { visibleTabs } from "@/lib/nav-tabs";
import { SITE_WEB_TABS } from "@/lib/labels";
import { formatDateTime } from "@/lib/utils";
import { etatAffiche, etatIntegration, journalRecent, listePublications } from "@/lib/site-web/etat";
import { lienDuContenu } from "@/lib/site-web/file";
import { LIBELLE_NATURE } from "@/lib/site-web/contrat";
import { peutEcrireArticles, peutGererLaLiaison, peutPublierOffres } from "@/lib/site-web/acces";
import { ECRAN_LIAISON } from "@/lib/site-web/ecran";
import { EtatPublicationBadge } from "@/components/site-web/etat-badge";
import { GesteIntegration } from "@/components/site-web/gestes-integration";

export const dynamic = "force-dynamic";
export const metadata = { title: "Site web — AMD Internal OS" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PUBLICATION VERS LE SITE PUBLIC (§118.158) — l'ERP est la source de vérité, il POUSSE.
 *
 * Cet écran répond à trois questions, dans l'ordre où on les pose :
 *   1. Est-ce que ça part ? — une phrase quand rien ne part (site pas encore relié, clé refusée),
 *      et c'est tout : la LIAISON elle-même (la clé, la vérification, le rapprochement à la
 *      demande, la mise en service) vit dans la console d'administration, que seul le Super Admin
 *      ouvre (§118.160). Les publiants n'ont pas de geste de liaison à faire — leur en montrer
 *      revenait à montrer des boutons qu'une action refuse ;
 *   2. Qu'est-ce qui est en ligne, en attente, en échec ? — un état par contenu, jamais
 *      « publié » tant que le site ne l'a pas confirmé ;
 *   3. Le site et l'ERP disent-ils la même chose ? — le dernier rapprochement, ses écarts, ce
 *      que le site détient et que l'ERP ne connaît pas (nommé, jamais supprimé).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function SiteWebPage() {
  const user = await requireModule("SITE_WEB");
  const [integ, publications, journal] = await Promise.all([
    etatIntegration(), listePublications(200), journalRecent(30),
  ]);
  const { config, blocage, suspendu, compteurs, dernier } = integ;
  // Le Super Admin est le seul à qui l'écran nomme l'endroit où la liaison se règle — les autres
  // apprennent seulement qu'un Super Admin s'en charge (§118.160).
  const gere = peutGererLaLiaison(user);
  const vues = publications.map((p) => ({ p, e: etatAffiche(p, p.operation === "PUT" && p.confirmePublie !== false, suspendu) }));
  const aTraiter = vues.filter(({ p }) => p.etat === "FAILED" || (p.etat === "PENDING" && p.essais > 0));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Site web — adventumdz.com"
        description="Les offres d'emploi et les articles de blog que l'ERP publie sur le site public. Chaque envoi est rejoué sans risque de doublon, réessayé s'il échoue, et rapproché chaque jour de ce que le site détient."
      >
        {peutEcrireArticles(user) && (
          <Link href="/site-web/articles/nouveau"><Button size="sm"><FileText className="h-4 w-4" /> Nouvel article</Button></Link>
        )}
        {peutPublierOffres(user) && (
          <Link href="/site-web/offres/nouvelle"><Button size="sm" variant="outline"><Briefcase className="h-4 w-4" /> Nouvelle offre</Button></Link>
        )}
        {config.racine && (
          <a href={config.racine} target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="ghost"><ExternalLink className="h-4 w-4" /> Ouvrir le site</Button>
          </a>
        )}
        {gere && (
          <Link href={ECRAN_LIAISON.href}><Button size="sm" variant="ghost"><KeyRound className="h-4 w-4" /> Connexion au site</Button></Link>
        )}
      </PageHeader>
      <ModuleTabs tabs={await visibleTabs(user, SITE_WEB_TABS)} />

      {/* ── 1. EST-CE QUE ÇA PART ? — une phrase, pas un geste (§118.160) ─────────────────── */}
      {/* LA LIAISON EST L'AFFAIRE DU SUPER ADMIN (25/11/2026) : un employé n'y peut rien, il ne voit pas ces bandeaux. Ses
          contenus partent en file comme d'habitude ; les compteurs « En file / En échec » restent visibles. */}
      {!gere ? null : blocage ? (
        <div role="alert" className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-semibold text-destructive">Publication vers le site suspendue depuis le {formatDateTime(blocage.at)}</p>
            <p className="mt-1 text-muted-foreground">
              Le site refuse les envois de l&apos;ERP : la liaison est à corriger. Rien n&apos;est perdu — les envois attendent en file et
              repartiront d&apos;eux-mêmes dès qu&apos;elle le sera.{" "}
              <Link href={ECRAN_LIAISON.href} className="font-medium text-primary underline">Rétablir la connexion</Link>
            </p>
          </div>
        </div>
      ) : !config.configuree ? (
        <div className="rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm">
          <p className="font-medium">Le site n&apos;est pas encore relié à l&apos;ERP.</p>
          <p className="mt-1 text-muted-foreground">
            Les contenus publiés d&apos;ici là attendent en file et partiront d&apos;eux-mêmes.{" "}
            <Link href={ECRAN_LIAISON.href} className="font-medium text-primary underline">Relier le site (un clic)</Link>
          </p>
        </div>
      ) : null}

      {/* ── 2. QU'EST-CE QUI EST EN LIGNE ? ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="En ligne" value={compteurs.enLigne} icon="Globe" tone={compteurs.enLigne ? "success" : "default"} />
        <KpiCard label="En file" value={compteurs.enFile} icon="Clock" tone={compteurs.enFile ? "info" : "default"} />
        <KpiCard label="En échec" value={compteurs.enEchec} icon="AlertTriangle" tone={compteurs.enEchec ? "danger" : "default"} />
        <KpiCard label="Retirés (brouillon sur le site)" value={compteurs.retires} icon="EyeOff" />
        <KpiCard label="Supprimés du site" value={compteurs.supprimes} icon="Trash2" />
      </div>

      {aTraiter.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-destructive">À regarder ({aTraiter.length})</h2>
          <ul className="divide-y divide-border rounded-xl border border-destructive/30">
            {aTraiter.map(({ p, e }) => (
              <li key={p.id} className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">
                    <Link href={lienDuContenu(p.nature, p.externalId)} className="hover:underline">{p.libelle}</Link>
                    <span className="ml-2 text-xs text-muted-foreground">{LIBELLE_NATURE[p.nature]}</span>
                  </p>
                  <EtatPublicationBadge etat={e} avecDetail />
                </div>
                {e.relancable && <GesteIntegration geste="relancer" publicationId={p.id} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Contenus envoyés au site</h2>
        {vues.length === 0 ? (
          <EmptyState
            icon="Globe"
            title="Rien n'a encore été envoyé au site"
            description="Publiez un article ou une offre d'emploi : il apparaîtra ici avec son état, puis « En ligne » dès que le site aura confirmé."
          />
        ) : (
          <div className="surface overflow-hidden">
            <Table mobileCards>
              <TableHeader>
                <TableRow>
                  <TableHead>Contenu</TableHead>
                  <TableHead>Nature</TableHead>
                  <TableHead>État sur le site</TableHead>
                  <TableHead>Dernier échange</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vues.map(({ p, e }) => (
                  <TableRow key={p.id}>
                    <TableCell label="Contenu" className="font-medium sm:max-w-[22rem]">
                      <Link href={lienDuContenu(p.nature, p.externalId)} className="break-words hover:underline">{p.libelle}</Link>
                    </TableCell>
                    <TableCell label="Nature">{LIBELLE_NATURE[p.nature]}</TableCell>
                    <TableCell label="État sur le site"><EtatPublicationBadge etat={e} /></TableCell>
                    <TableCell label="Dernier échange" className="text-xs text-muted-foreground">
                      {p.derniereTentative ? `${formatDateTime(p.derniereTentative)}${p.dernierStatut ? ` · ${p.dernierStatut}` : ""}` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* ── 3. LE SITE ET L'ERP DISENT-ILS LA MÊME CHOSE ? ──────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>Rapprochement quotidien</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!dernier ? (
            <p className="text-muted-foreground">
              Aucun rapprochement encore. Il a lieu chaque jour (lecture de GET /jobs et GET /posts, comparée à ce que l&apos;ERP veut) dès que
              l&apos;intégration est configurée{gere ? ` — ou maintenant, depuis ${ECRAN_LIAISON.nom}` : ""}.
            </p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={dernier.ok ? "success" : "danger"} dot>{dernier.ok ? "Réussi" : "Échoué"}</Badge>
                <span>{formatDateTime(dernier.at)} · {dernier.declencheur === "MANUEL" ? "lancé à la main" : "automatique"}</span>
                {integ.dernierReussi && !dernier.ok && (
                  <span className="text-muted-foreground">— dernier réussi le {formatDateTime(integ.dernierReussi)}</span>
                )}
              </p>
              {dernier.erreur && <p className={dernier.ok ? "text-warning" : "text-destructive"}>{dernier.erreur}</p>}
              {dernier.ok && (
                <p className="text-muted-foreground">
                  Le site détenait {dernier.siteJobs ?? 0} offre(s) et {dernier.sitePosts ?? 0} article(s) · {dernier.conformes} conforme(s)
                  {dernier.repousses ? ` · ${dernier.repousses} repoussé(s)` : ""}
                  {dernier.suppressions ? ` · ${dernier.suppressions} suppression(s) rejouée(s)` : ""}
                  {dernier.rejetes ? ` · ${dernier.rejetes} à corriger` : ""}
                  {dernier.manuels && (dernier.manuels.jobs || dernier.manuels.posts)
                    ? ` · ${dernier.manuels.jobs + dernier.manuels.posts} saisi(s) dans l'admin du site (hors ERP, non touchés)`
                    : ""}.
                </p>
              )}
              {dernier.collisions.length > 0 && (
                <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
                  <p className="flex items-center gap-1.5 font-medium text-warning"><AlertTriangle className="h-4 w-4" /> Articles masqués par un article du dépôt du site</p>
                  <ul className="mt-1 space-y-1">
                    {dernier.collisions.map((c) => (
                      <li key={c.externalId}>
                        <Link href={`/site-web/articles/${c.externalId}`} className="font-medium hover:underline">{c.libelle}</Link>
                        {" "}— /blog/{c.slug} affiche « {c.titreDuDepot} ». Donnez à l&apos;article une autre adresse.
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {dernier.ecarts.length > 0 && (
                <div>
                  <p className="font-medium">Écarts trouvés</p>
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    {dernier.ecarts.slice(0, 20).map((e) => (
                      <li key={`${e.nature}:${e.externalId}`} className="break-words">
                        <span className="text-foreground">{e.libelle}</span> ({e.nature === "JOB" ? "offre" : "article"}) — {e.raison}
                      </li>
                    ))}
                    {dernier.ecarts.length > 20 && <li>… et {dernier.ecarts.length - 20} autre(s).</li>}
                  </ul>
                </div>
              )}
              {dernier.orphelins.length > 0 && (
                <div className="rounded-lg border border-border p-3">
                  <p className="font-medium">Présents sur le site, inconnus de l&apos;ERP ({dernier.orphelins.length})</p>
                  <p className="text-xs text-muted-foreground">
                    Ils n&apos;ont PAS été supprimés : ne pas les trouver ici ne prouve pas qu&apos;ils doivent disparaître (un test de mise en
                    service, un autre environnement…). Supprimez-les depuis l&apos;administration du site s&apos;ils n&apos;ont plus lieu d&apos;être.
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {dernier.orphelins.slice(0, 20).map((o) => (
                      <li key={`${o.nature}:${o.externalId}`} className="break-words">
                        {o.titre} <span className="font-mono text-xs text-muted-foreground">({o.externalId})</span>
                        {o.url && <> — <span className="font-mono text-xs">{o.url}</span></>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {journal.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Journal des derniers envois</h2>
          <div className="surface overflow-hidden">
            <Table mobileCards>
              <TableHeader>
                <TableRow>
                  <TableHead>Quand</TableHead>
                  <TableHead>Requête</TableHead>
                  <TableHead>Réponse</TableHead>
                  <TableHead>Détail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {journal.map((l, i) => (
                  <TableRow key={`${l.at.toISOString()}-${i}`}>
                    <TableCell label="Quand" className="whitespace-nowrap text-xs">{formatDateTime(l.at)}</TableCell>
                    <TableCell label="Requête" className="font-mono text-xs">
                      <span>
                        {l.methode} {l.chemin}
                        <span className="block font-sans text-muted-foreground">{l.libelle}</span>
                      </span>
                    </TableCell>
                    <TableCell label="Réponse" className="text-xs">
                      <span>
                        <Badge tone={l.issue === "SUCCES" || l.issue === "DEJA_ABSENT" ? "success" : l.issue === "REESSAYER" || l.issue === "LOCAL" ? "warning" : "danger"}>
                          {l.statut ?? "—"} · {l.issue}
                        </Badge>
                        <span className="block text-muted-foreground">{l.ms} ms</span>
                      </span>
                    </TableCell>
                    <TableCell label="Détail" className="break-words text-xs text-muted-foreground sm:max-w-[26rem]">{l.erreur ?? l.extrait ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}
