import Link from "next/link";
import { ExternalLink, Paperclip } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getMyValidations, type PendingValidationItem, type MyValidationItem } from "@/lib/queries/validations";
import { groupValidations, type ValidationGroup } from "@/lib/validations/grouping";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { optionsFromMap } from "@/components/shared/form-fields";
import { PRIORITY, VALIDATION_STATUS, VALIDATION_STEP_STATE, VALIDATION_MODE } from "@/lib/labels";
import { bcDesDemandes, bcImportables, peutCreerUnBC } from "@/lib/bons-de-commande/retenue-bc";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { LIBELLE_ETAPE_BC } from "@/lib/bons-de-commande/regle";
import { compositionDesPieces } from "@/lib/queries/composition-pieces";
import { DemanderUneValidation } from "./demande-validation";
import { ValidationFinaleBC } from "./validation-finale-bc";
import { formatCurrency, formatDate, formatDateTime, daysUntil } from "@/lib/utils";
import { ValidationDecision } from "./validation-decision";
import { ItemReview } from "./validation-item-review";
import { ValidationAttachments } from "./validation-attachments";
import { SupervisionBoard } from "./supervision-board";
import { supervisionCounters } from "@/lib/validation-supervision";
import { NewPaymentButton } from "./paiements/new-payment-button";
import { myPaymentRequests } from "@/modules/finances/api";
import { sortByPriority, isOverdue, deadlineLabel } from "@/modules/finances/partage";
import { PAYMENT_REQUEST_STATUS, PAYMENT_URGENCY } from "@/lib/labels";
import { toNumber } from "@/lib/utils";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { DocumentList } from "@/components/documents/document-list";

export default async function ValidationsPage(props: { searchParams: Promise<{ focus?: string }> }) {
  const searchParams = await props.searchParams;
  /**
   * `?focus=<stepId>` — ON ARRIVE **DANS** LA VALIDATION.
   *
   * Depuis « Mon espace », cliquer une validation menait à cet écran et pas plus loin : on
   * cherchait des yeux, dans une liste, la ligne qu'on venait de cliquer. La validation visée
   * passe désormais EN TÊTE, encadrée, avec ses pièces et son panneau de décision ouverts —
   * on agit sans un clic de plus.
   */
  const focusStep = searchParams.focus ?? null;
  const user = await requireModule("VALIDATIONS");
  const { toValidate, myRequests, supervised } = await getMyValidations(user);
  // À traiter maintenant (mon tour) vs assignées mais en attente du validateur précédent.
  const focusFirst = <T extends { stepId: string }>(list: T[]): T[] =>
    focusStep ? [...list].sort((a, b) => Number(b.stepId === focusStep) - Number(a.stepId === focusStep)) : list;
  const actionable = focusFirst(toValidate.filter((v) => v.actionable));

  // Validateurs possibles : tous les collaborateurs actifs (le demandeur s'exclut
  // de fait, l'action ignore une étape qui le viserait lui-même).
  const [people, importables, composition] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true, id: { not: user.id } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    bcImportables(user),
    compositionDesPieces(user),
  ]);
  const peopleOptions = people.map((p) => ({ value: p.id, label: p.name }));
  // Le compositeur n'est offert que si la personne peut ÉMETTRE un bon de commande (même règle que Legal).
  const compositionBC = composition?.types.includes("BON_DE_COMMANDE")
    ? { societes: composition.societes, societeParDefaut: composition.societeParDefaut, letterheads: composition.letterheads, peutReglerNumerotation: composition.peutReglerNumerotation, amont: composition.amont }
    : null;

  // UNE DEMANDE = UNE DEMANDE. Les validations de pièces se regroupent sous la demande dont
  // elles proviennent : sans cela, quatre pièces soumises séparément s'affichaient comme quatre
  // demandes, et l'acceptation de l'une se lisait comme celle du tout.
  const myGroups = groupValidations(myRequests);
  // LES PRÉ-VALIDATIONS DE BC : le BC visé, s'il est encore retenu (CTA « validation finale »), et où il en est ensuite.
  const prevalidations = await bcDesDemandes(myGroups.flatMap((g) => (g.main ? [g.main.id] : [])));
  const etatsBC = await etatsDesBC([...prevalidations.values()].map((p) => p.docId));
  const pendingMine = myGroups.filter((g) => g.status === "PENDING").length;
  // Les compteurs de supervision sont calculés côté serveur pour l'en-tête ; le tableau les
  // recalcule pour ses filtres, à partir des MÊMES fonctions pures — les deux ne peuvent pas
  // diverger.
  const supervisionStats = supervisionCounters(supervised, new Date());
  // La supervision de TOUTE la société est un pouvoir de contrôle, pas un outil de travail :
  // elle se referme sur le Super Admin.
  const peutSuperviser = user.role === "SUPER_ADMIN";

  // L'entité d'une demande de paiement ne se choisit plus : elle est rattachée à Adventum d'office.
  // MES DEMANDES DE PAIEMENT — voir la section plus bas : cet écran est la SEULE porte du
  // circuit, il doit donc montrer ce qu'on y a déposé.
  const mesPaiements = await myPaymentRequests(user.id, 50);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Demandes de validations"
        description="Le bureau de validation : demandez une validation professionnelle à la personne de votre choix, et traitez ce qui requiert la vôtre. Le demandeur ne voit que ses propres demandes ; les validateurs voient ce qu'ils ont à valider."
      >
        <DemanderUneValidation
          personnes={peopleOptions}
          priorites={optionsFromMap(PRIORITY)}
          bcImportables={importables}
          peutDeposerBC={peutCreerUnBC(user)}
          composition={compositionBC}
        />
        {/* LA DEMANDE DE PAIEMENT SE FAIT D'ICI — c'est sa seule porte d'entrée, le module à
            part a disparu. Le dossier passe OBLIGATOIREMENT par le centre de paiement — tout
            paiement, quel que soit son montant —, puis atterrit dans les Règlements à effectuer. */}
        <NewPaymentButton />
      </PageHeader>

      {/* LE RACCOURCI « Suivi des demandes de paiement » A ÉTÉ RETIRÉ DU HAUT DE PAGE (2026-08) :
          une bannière y repoussait ce qu'on vient réellement faire ici. Le suivi, lui, est REVENU
          — en BAS, à sa place, sous forme de liste (2026-09). Voir la section « Mes demandes de
          paiement » : sans elle, un dossier quitté n'était plus atteignable par personne. */}

      {/* Les chiffres du haut répondent à « qu'est-ce qui m'attend ? » puis, pour la Direction,
          à « qu'est-ce qui est en retard, et où ? » — pas à « combien en ai-je envoyé ». */}
      <div className={`grid grid-cols-2 gap-3 ${peutSuperviser && supervised.length > 0 ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        <KpiCard label="À valider par vous" value={actionable.length} icon="ShieldCheck" tone={actionable.length > 0 ? "warning" : "default"} />
        {peutSuperviser && supervised.length > 0 && (
          <KpiCard
            label="En retard (société)" value={supervisionStats.overdue} icon="AlarmClock"
            tone={supervisionStats.overdue > 0 ? "danger" : "default"}
            hint={supervisionStats.stalled > 0 ? `${supervisionStats.stalled} sans décision depuis 7 j` : undefined}
          />
        )}
        <KpiCard label="Mes demandes en cours" value={pendingMine} icon="Hourglass" tone="info" />
        <KpiCard label="Total de mes demandes" value={myGroups.length} icon="ListChecks" />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">À valider ({actionable.length})</h2>
        {actionable.length === 0 ? (
          <EmptyState icon="CheckCheck" title="Aucune validation en attente" description="Les éléments qui requièrent votre validation apparaîtront ici." />
        ) : (
          <div className="space-y-3">
            {actionable.map((v) => <PendingValidationCard key={v.stepId} v={v} actionable focused={v.stepId === focusStep} />)}
          </div>
        )}
      </section>

      {/* SUPERVISION — RÉSERVÉE AU SUPER ADMIN. Lire tout ce qui circule dans la société, et
          relancer n'importe quel validateur, n'est pas un besoin de travail : c'est un pouvoir de
          contrôle. Il restait ouvert à quiconque avait la portée « toutes les lignes », ce qui en
          faisait un tableau de surveillance par accident. */}
      {peutSuperviser && supervised.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Supervision — tout ce qui circule ({supervised.length})
            </h2>
            <p className="text-xs text-muted-foreground">
              Vue Direction : les demandes de validation de toute la société, <strong>la plus urgente en tête</strong>,
              avec le validateur chez qui elles attendent. Les compteurs sont des filtres ; la relance part en
              notification (et en push) à la personne dont on attend la décision.
            </p>
          </div>
          <SupervisionBoard rows={supervised} isSuperAdmin={user.role === "SUPER_ADMIN"} />
        </section>
      )}

      {/* DEUX BLOCS RETIRÉS (2026-08) — « Qui vous reviendront » et « Validations transverses ».
          Le premier montrait des demandes sur lesquelles on ne peut RIEN faire : elles reviennent
          d'elles-mêmes dans « À traiter » le jour où c'est notre tour, et les lister d'avance
          faisait chercher un bouton qui n'existait pas. Le second doublait les écrans de chaque
          module, où la validation se fait AVEC son contexte. */}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Mes demandes de validation ({myGroups.length})</h2>
        {myGroups.length === 0 ? (
          <EmptyState icon="Send" title="Aucune demande envoyée" description="Vos demandes de validation et leur avancement apparaîtront ici." />
        ) : (
          <div className="space-y-2">
            {myGroups.map((g) => {
              const pv = g.main ? prevalidations.get(g.main.id) : undefined;
              const bc = pv ? etatsBC.get(pv.docId) : undefined;
              return (
                <MyRequestCard
                  key={g.key} g={g} isSuperAdmin={user.role === "SUPER_ADMIN"}
                  bc={pv && bc ? { docId: pv.docId, reference: bc.reference ?? bc.title, retenu: pv.retenu, etape: pv.retenu ? null : LIBELLE_ETAPE_BC[bc.etape] } : null}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ───────────── MES DEMANDES DE PAIEMENT ─────────────
          UN ÉCRAN OÙ L'ON DÉPOSE DOIT MONTRER CE QU'ON Y A DÉPOSÉ.

          Le bouton « Demander un paiement » ci-dessus est la SEULE porte du circuit : les
          demandes de paiement n'ont plus d'entrée de menu. Le formulaire conduisait sur la fiche
          du dossier — et c'était tout. Une fois cette fiche quittée, plus rien n'y ramenait : ni
          pour suivre l'instruction, ni pour joindre la pièce que les Finances réclament. « Je
          l'envoie, et je ne la vois plus. »

          La section ne s'affiche que si l'on a des demandes : un bloc vide en permanence sur
          l'écran de validation serait exactement la bannière qu'on avait retirée. */}
      {mesPaiements.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Mes demandes de paiement ({mesPaiements.length})
            </h2>
            {/* La liste COMPLÈTE, avec la file des Finances pour qui l'instruit. */}
            <Link href="/validations/paiements" className="text-xs font-medium text-primary hover:underline">
              Tout voir
            </Link>
          </div>
          <div className="surface divide-y divide-border p-0">
            {sortByPriority(mesPaiements).map((p) => (
              <Link
                key={p.id} href={`/validations/paiements/${p.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-secondary/40"
              >
                <span className="font-mono text-xs text-muted-foreground">{p.reference}</span>
                {/* Au téléphone, l'objet prend sa propre ligne : tronqué à côté de la référence, il ne disait plus rien. */}
                <span className="w-full min-w-0 truncate font-medium sm:w-auto sm:flex-1">{p.title}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{p.payee}</span>
                <span className="whitespace-nowrap font-semibold tabular-nums">{formatCurrency(toNumber(p.amount))}</span>
                <span className="text-xs text-muted-foreground">
                  {deadlineLabel(p, PAYMENT_URGENCY)}
                  {isOverdue(p) && <Badge tone="danger" dot={false} className="ml-1.5">en retard</Badge>}
                </span>
                <StatusBadge map={PAYMENT_REQUEST_STATUS} value={p.status} dot={false} />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * UNE DEMANDE, UNE CARTE — même quand ses pièces ont été soumises séparément.
 *
 * Le statut affiché est celui du TOUT : une facture acceptée pendant que le bon de commande
 * attend ne fait pas une demande acceptée. Le détail par pièce est là, juste en dessous, avec
 * son propre verdict — c'est là, et seulement là, qu'« accepté » veut dire « cette pièce ».
 */
function MyRequestCard({ g, isSuperAdmin, bc }: {
  g: ValidationGroup<MyValidationItem>; isSuperAdmin: boolean;
  /** La pré-validation d'un BC : la pièce, si elle est encore retenue, et son étape une fois la validation finale demandée. */
  bc: { docId: string; reference: string; retenu: boolean; etape: string | null } | null;
}) {
  const head = g.main ?? g.pieces[0];
  return (
    <Card>
      <CardContent className="space-y-2 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{head.reference}</span>
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{g.title}</span>
            <Badge tone="neutral" dot={false}>{head.module}</Badge>
            {g.main && <span className="text-xs text-muted-foreground">{VALIDATION_MODE[g.main.mode]}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {head.amount !== null && <span className="whitespace-nowrap text-sm font-semibold tabular-nums">{formatCurrency(head.amount)}</span>}
            <StatusBadge map={VALIDATION_STATUS} value={g.status} />
            {/* OUVRIR SA DEMANDE : relire ce qu'on a écrit, rouvrir la pièce envoyée, voir qui
                bloque. Sans cette porte, il fallait téléphoner au validateur — le coup de fil
                que ce module existe précisément pour éviter. */}
            <Link
              href={`/validations/${head.id}`}
              className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-3 py-1 text-xs font-medium hover:bg-secondary sm:min-h-0 sm:px-2.5"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Ouvrir
            </Link>
            {isSuperAdmin && g.main && (
              <SuperAdminDeleteButton kind="VALIDATION_REQUEST" id={g.main.id} name={`${g.main.reference} — ${g.main.title}`} enabled />
            )}
          </div>
        </div>

        {/* La phrase qui lève l'ambiguïté, avant tout le reste. */}
        {g.summary && <p className="text-xs text-muted-foreground">{g.summary}</p>}

        {g.main && <StepChips steps={g.main.steps} />}

        {/* LA PRÉ-VALIDATION D'UN BC : acquise, le demandeur demande la validation finale ; ensuite, on suit le BC. */}
        {bc && g.main && (
          bc.retenu
            ? (g.main.status === "APPROVED"
              ? <ValidationFinaleBC demandeId={g.main.id} reference={bc.reference} />
              : <p className="text-xs text-muted-foreground">Pré-validation du bon de commande {bc.reference} : la validation finale se demandera quand tous les validateurs auront accepté.</p>)
            : (
              <p className="flex flex-wrap items-center gap-x-2 text-xs">
                <span className="text-muted-foreground">Validation finale demandée — bon de commande {bc.reference} :</span>
                <span className="font-medium">{bc.etape}</span>
                <Link href={`/legal/${bc.docId}`} className="text-primary hover:underline">Ouvrir le bon de commande</Link>
              </p>
            )
        )}

        {/* PIÈCE PAR PIÈCE — chaque validation garde SON verdict, clairement nommée. */}
        {g.pieces.length > 0 && (
          <ul className="space-y-1.5 rounded-lg border border-border/60 bg-secondary/20 p-2">
            {g.pieces.map((p) => (
              <li key={p.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{p.documentName ?? p.title}</span>
                  <span className="font-mono text-muted-foreground">{p.reference}</span>
                  <StatusBadge map={VALIDATION_STATUS} value={p.status} dot={false} />
                </div>
                <div className="pl-5"><StepChips steps={p.steps} /></div>
              </li>
            ))}
          </ul>
        )}

        {/* Retour DÉTAILLÉ par élément (message + pièces) : le demandeur voit exactement ce qui va / ne va pas. */}
        {[g.main, ...g.pieces].filter((r): r is MyValidationItem => Boolean(r)).flatMap((r) => r.steps).some((s) => s.items && s.items.length > 0) && (
          <div className="space-y-1.5 rounded-lg border border-border/60 bg-secondary/20 p-2">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Retour détaillé par élément</p>
            {[g.main, ...g.pieces].filter((r): r is MyValidationItem => Boolean(r)).map((r) =>
              r.steps.filter((s) => s.items && s.items.length > 0).map((s) => (
                <div key={`${r.id}-${s.order}`} className="space-y-0.5">
                  <p className="text-xs font-medium">{s.validator}</p>
                  <ul className="space-y-0.5 pl-3">
                    {s.items!.map((it, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">{it.label}</span>
                        <StatusBadge map={VALIDATION_STEP_STATE} value={it.decision} dot={false} />
                        {it.comment && <span className="text-muted-foreground">— {it.comment}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )),
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Les validateurs d'un circuit et leur verdict, en pastilles. */
function StepChips({ steps }: { steps: MyValidationItem["steps"] }) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {steps.map((s) => (
        <span key={s.order} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs" title={s.reason || undefined}>
          <span className="text-muted-foreground">{s.order}.</span>
          <span>{s.validator}</span>
          <StatusBadge map={VALIDATION_STEP_STATE} value={s.status} dot={false} />
        </span>
      ))}
    </div>
  );
}

/**
 * Carte d'une demande qui M'EST assignée comme validateur. Le validateur y a un ACCÈS
 * COMPLET à la demande : contexte, échéance, lien vers l'objet, et surtout les PIÈCES
 * (aperçu sur place, lecture seule). Quand c'est son tour (`actionable`), le panneau de
 * décision permet de VALIDER / demander une MODIFICATION / REFUSER — avec un commentaire
 * optionnel dans les trois cas. Sinon (circuit séquentiel, pas encore son tour), il
 * consulte déjà tout mais un badge indique qu'il décidera le moment venu.
 */
function PendingValidationCard({ v, actionable, focused = false }: { v: PendingValidationItem; actionable: boolean; focused?: boolean }) {
  const d = v.deadline ? daysUntil(v.deadline) : null;
  const msgDecision = v.itemDecisions.find((x) => x.itemKey === "MESSAGE");
  return (
    <Card id={`val-${v.stepId}`} className={focused ? "scroll-mt-24 ring-2 ring-primary/50" : "scroll-mt-24"}>
      <CardContent className="flex flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{v.reference}</span>
            <Badge tone="neutral" dot={false}>{v.module}</Badge>
            {v.objectType && <Badge tone="neutral" dot={false}>{v.objectType}</Badge>}
            <StatusBadge map={PRIORITY} value={v.priority} dot={false} />
            {v.amount !== null && <span className="whitespace-nowrap text-sm font-semibold tabular-nums">{formatCurrency(v.amount)}</span>}
            {/* En intérim, on tranche AU NOM de l'absent : la carte le dit avant le bouton (I18). */}
            {v.pourLeCompteDe && <Badge tone="info" dot={false}>Intérim pour {v.pourLeCompteDe}</Badge>}
          </div>
          <p className="font-medium [overflow-wrap:anywhere]">{v.title}</p>
          {v.description && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{v.description}</p>}
          {/* Verdict par ÉLÉMENT (message) : approuver / réviser / refuser + commentaire optionnel. */}
          {actionable && (
            <div className="rounded-lg border border-border/60 bg-secondary/20 p-2">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Votre avis sur le message</p>
              <ItemReview stepId={v.stepId} itemKey="MESSAGE" current={msgDecision?.decision} currentComment={msgDecision?.comment} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Demandé par {v.requester || "—"} · {formatDateTime(v.createdAt)}
            {v.deadline ? ` · échéance ${formatDate(v.deadline)}${d !== null && d < 0 ? " (en retard)" : ""}` : ""}
          </p>
          {v.link && (
            <Link href={v.link} className="inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline sm:min-h-0">
              <ExternalLink className="h-3.5 w-3.5" /> Ouvrir l&apos;élément
            </Link>
          )}
          {v.documents.length > 0 && (
            <div className="mt-1 rounded-lg border border-border/60 bg-secondary/30 p-2">
              <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                Pièces à valider ({v.documents.length})
              </p>
              {/* Actionnable : aperçu sur place + verdict PAR pièce. Sinon : lecture seule. */}
              {actionable ? (
                <ValidationAttachments stepId={v.stepId} documents={v.documents} decisions={v.itemDecisions} />
              ) : (
                <DocumentList documents={v.documents} />
              )}
            </div>
          )}
        </div>
        <div className="w-full shrink-0 border-t border-border/60 pt-3 lg:w-auto lg:border-0 lg:pt-0">
          {actionable ? (
            <ValidationDecision stepId={v.stepId} />
          ) : (
            <Badge tone="warning" dot={false}>En attente de votre tour</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
