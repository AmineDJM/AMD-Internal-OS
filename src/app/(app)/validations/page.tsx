import Link from "next/link";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getMyValidationRequests, getSupervisedValidations, type MyValidationItem } from "@/lib/queries/validations";
import { groupValidations } from "@/lib/validations/grouping";
import { ouvreLeCentreDeValidations } from "@/lib/validations/centre";
import { fileDuCentre, decisionsRecentes } from "@/lib/queries/centre-validations";
import { panneauDeLAdresse, type LigneEnvoyee } from "@/lib/validations/centre-affichage";
import { optionsFromMap } from "@/components/shared/form-fields";
import { PRIORITY, PAYMENT_URGENCY } from "@/lib/labels";
import { bcDesDemandes, bcImportables, peutCreerUnBC } from "@/lib/bons-de-commande/retenue-bc";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { LIBELLE_ETAPE_BC } from "@/lib/bons-de-commande/regle";
import { compositionDesPieces } from "@/lib/queries/composition-pieces";
import { getAppSettings } from "@/lib/settings";
import { myPaymentRequests } from "@/modules/finances/api";
import { lignesMesDemandes } from "@/modules/finances/partage";
import { DemanderUneValidation } from "./demande-validation";
import { NewPaymentButton } from "./paiements/new-payment-button";
import { ListeMesDemandes } from "./paiements/liste-mes-demandes";
import { SupervisionBoard } from "./supervision-board";
import { CentreValidations } from "./centre-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de validations — AMD Internal OS" };

/**
 * LE CENTRE DE VALIDATIONS — UN SEUL ÉCRAN (maquette validée par le Super Admin le 24/11/2026, `CentreValidations.dc.html`).
 *
 * Hier, deux écrans : « Demandes de validations » (`/validations`, où chacun demande et décide) et le « Centre de
 * validations » (`/centre-de-validations`, la même file pour le Directeur Général et le Super Admin, plus le seuil des
 * BC). Ils lisaient la MÊME file (`getPendingValidations`) : on les réunit ici. `/centre-de-validations` garde sa
 * porte et son entrée de menu, et mène ici.
 *
 * La disposition : le titre et le menu ⋯ ; à gauche la file « À décider » (seules les étapes décidables maintenant) ; à
 * droite la fiche de la demande choisie — l'essentiel, les alertes, ce qui est déjà validé, les pièces en aperçu, et les
 * gestes : accepter, refuser avec motif, demander une précision (ou renvoyer pour correction). Derrière ⋯ : déjà
 * décidés, mes demandes envoyées (avec « Demander une validation » et les demandes de paiement), les règles (le seuil
 * des BC, réglé par qui a accès au centre) et, pour le Super Admin, la supervision.
 *
 * `?focus=<étape>` (liens des notifications, « Mon espace ») ouvre la fiche de cette étape ; `?vue=` ouvre un panneau.
 */
export default async function ValidationsPage(props: { searchParams: Promise<{ focus?: string; demande?: string; vue?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("VALIDATIONS");
  const reglages = await getAppSettings();
  const seuilBC = reglages.bcValidationThresholdCentre;
  const estSuperAdmin = user.role === "SUPER_ADMIN";

  const [file, decides, mesDemandes, mesPaiements, supervised, people, importables, composition] = await Promise.all([
    fileDuCentre(user, { seuilBC }),
    decisionsRecentes(user.id),
    getMyValidationRequests(user.id),
    myPaymentRequests(user.id, 50),
    // LA SUPERVISION de toute la société est un pouvoir de contrôle : elle se referme sur le Super Admin.
    estSuperAdmin ? getSupervisedValidations(user) : Promise.resolve([]),
    prisma.user.findMany({ where: { isActive: true, id: { not: user.id } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    bcImportables(user),
    compositionDesPieces(user),
  ]);

  // MES DEMANDES ENVOYÉES — une demande = une demande : ses pièces soumises à part se regroupent sous elle.
  const groupes = groupValidations(mesDemandes);
  const prevalidations = await bcDesDemandes(groupes.flatMap((g) => (g.main ? [g.main.id] : [])));
  const [etatsBC, decisionsDe] = await Promise.all([
    etatsDesBC([...prevalidations.values()].map((p) => p.docId)),
    prisma.validationRequest.findMany({ where: { id: { in: mesDemandes.map((m) => m.id) } }, select: { id: true, decidedAt: true } }),
  ]);
  const decideeLe = new Map(decisionsDe.map((d) => [d.id, d.decidedAt?.toISOString() ?? null]));
  const envoyees: LigneEnvoyee[] = groupes.map((g) => {
    const head = (g.main ?? g.pieces[0]) as MyValidationItem;
    const pv = g.main ? prevalidations.get(g.main.id) : undefined;
    const bc = pv ? etatsBC.get(pv.docId) : undefined;
    const toutes = [g.main, ...g.pieces].filter((r): r is MyValidationItem => Boolean(r));
    return {
      key: g.key, id: head.id, mainId: g.main?.id ?? null, reference: head.reference, objet: g.title,
      a: [...new Set(head.steps.map((s) => s.validator).filter(Boolean))].join(", ") || "—",
      status: g.status, depuis: g.createdAt, decideeLe: decideeLe.get(head.id) ?? null, resume: g.summary,
      retours: toutes.flatMap((r) => r.steps.flatMap((s) => (s.items ?? []).map((it) => ({ validateur: s.validator, element: it.label, decision: it.decision, commentaire: it.comment })))),
      bc: pv && bc ? { docId: pv.docId, reference: bc.reference ?? bc.title, retenu: pv.retenu, etape: pv.retenu ? null : LIBELLE_ETAPE_BC[bc.etape] } : null,
    };
  });

  const compositionBC = composition?.types.includes("BON_DE_COMMANDE")
    ? { societes: composition.societes, societeParDefaut: composition.societeParDefaut, letterheads: composition.letterheads, peutReglerNumerotation: composition.peutReglerNumerotation, amont: composition.amont }
    : null;

  return (
    <CentreValidations
      file={file}
      decides={decides}
      envoyees={envoyees}
      seuilBC={seuilBC}
      peutReglerSeuil={ouvreLeCentreDeValidations(user)}
      estSuperAdmin={estSuperAdmin}
      nbSupervision={supervised.length}
      nbPaiements={mesPaiements.length}
      focus={searchParams.focus ?? null}
      demande={searchParams.demande ?? null}
      vue={panneauDeLAdresse(searchParams.vue)}
      demander={
        <>
          <DemanderUneValidation
            personnes={people.map((p) => ({ value: p.id, label: p.name }))}
            priorites={optionsFromMap(PRIORITY)}
            bcImportables={importables}
            peutDeposerBC={peutCreerUnBC(user)}
            composition={compositionBC}
          />
          {/* LA DEMANDE DE PAIEMENT SE FAIT D'ICI — sa seule porte d'entrée ; le dossier passe ensuite par le centre de paiement. */}
          <NewPaymentButton />
        </>
      }
      paiements={
        mesPaiements.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Mes demandes de paiement · {mesPaiements.length}</h3>
              <Link href="/validations/paiements" className="text-sm font-semibold text-primary hover:underline">Tout voir</Link>
            </div>
            <ListeMesDemandes lignes={lignesMesDemandes(mesPaiements, PAYMENT_URGENCY)} forme="liste" />
          </div>
        ) : null
      }
      supervision={estSuperAdmin ? <SupervisionBoard rows={supervised} isSuperAdmin /> : null}
    />
  );
}
