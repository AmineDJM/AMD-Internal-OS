import { Filter } from "lucide-react";
import { requireModule } from "@/lib/session";
import { getDeclarations, declarationsHiddenByScope } from "@/lib/queries/medical-info";
import { getCompanyScope, getMyCompanies } from "@/lib/company";
import { hiddenByScopeMessage } from "@/lib/company-visibility";
import { toNumber } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { InfoBulle } from "@/components/ui/info-bulle";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { CIRCUIT_LABEL, CIRCUIT_HINT, DECLARATION_KIND_LABEL, isDeclarationKind } from "@/lib/medical-info/circuits";
import { circuitStatesOf } from "@/lib/medical-info/circuit-state";
import { parcoursOf, libellePastille, joursDepuis, tonDelai, type Parcours } from "@/lib/medical-info/parcours";
import { produitsDesDossiers } from "@/lib/medical-info/produits";
import { decideursInfoMedActifs } from "@/lib/medical-info";
import { chezDecideur } from "@/lib/medical-info/decideur";
import { CreateDeclarationButton } from "./[id]/panels";
import { DossiersTable, type LigneDossier } from "./dossiers-table";

export const dynamic = "force-dynamic";

export default async function MedicalInfoPage() {
  const user = await requireModule("MEDICAL_INFO");
  const [declarations, portee, myCompanies] = await Promise.all([
    getDeclarations(user),
    declarationsHiddenByScope(user),
    getMyCompanies(user.id),
  ]);
  // CE QUE LE FILTRE D'ENTITÉ CACHE, dit au lieu d'être subi : sans ce chiffre, on voit des
  // déclarations dans « Mon espace » et pas dans son module, et rien ne relie les deux faits.
  const scopeId = getCompanyScope();
  const masques = hiddenByScopeMessage({
    ...portee,
    companyLabel: scopeId ? (myCompanies.find((c) => c.id === scopeId)?.name ?? null) : null,
  });

  // LE PHARMACIEN OUVRE, LES AUTRES LISENT. Le geste appartient à qui instruit le dossier.
  const canOpen = hasGlobalView(user.role) || userCan(user, "MEDICAL_INFO", "VALIDATE");

  // OÙ EN EST CHAQUE DOSSIER — la même lecture que la fiche, en un aller-retour par table.
  const [etats, produits, decideurs] = await Promise.all([circuitStatesOf(declarations), produitsDesDossiers(declarations), decideursInfoMedActifs(null)]);
  // Chez qui attendent les décisions du pharmacien : le Directeur des Opérations, ou le Super Admin à défaut.
  const chez = chezDecideur(decideurs);
  const now = new Date();
  const lus = declarations.map((d) => {
    const etat = etats.get(d.id)!;
    const parcours: Parcours = parcoursOf({
      circuit: etat.circuit, status: d.status, createdAt: d.createdAt, updatedAt: d.updatedAt,
      declare: etat.declare, declareRequestedAt: d.declareRequestedAt, authorityRef: d.authorityRef,
      lot: etat.lot, slips: etat.slips, summary: etat.summary, skipped: etat.skipped, bvRequestedAt: d.bvRequestedAt,
      requests: d.requests.map((r) => ({
        id: r.id, status: r.status, createdAt: r.createdAt, fulfilledAt: r.fulfilledAt,
        targetUserId: r.targetUserId, targetName: r.targetUser?.name ?? null,
      })),
      pharmacistValidatedAt: d.pharmacistValidatedAt, validatedAt: d.validatedAt, pharmacistName: d.pharmacist?.name ?? null,
      chezDecideur: chez,
    });
    return { d, etat, parcours, jours: joursDepuis(parcours.depuis, now) };
  });

  // Le plus ancien en attente d'abord ; les validés en bas, du plus récent au plus ancien.
  const ordonnes = [...lus].sort((a, b) => {
    const va = a.parcours.groupe === "VALIDE";
    const vb = b.parcours.groupe === "VALIDE";
    if (va !== vb) return va ? 1 : -1;
    if (va) return (b.d.validatedAt?.getTime() ?? 0) - (a.d.validatedAt?.getTime() ?? 0);
    return (b.jours ?? 0) - (a.jours ?? 0);
  });
  const lignes: LigneDossier[] = ordonnes
    .map(({ d, etat, parcours, jours }) => ({
      id: d.id,
      reference: d.reference,
      label: d.label,
      nature: isDeclarationKind(d.declarationKind)
        ? DECLARATION_KIND_LABEL[d.declarationKind]
        : (ENTITY_TYPE_LABELS[d.sourceType] ?? d.sourceType),
      detail: d.beneficiary,
      circuit: etat.circuit,
      produit: produits.get(d.id) ?? null,
      montant: d.amount != null ? toNumber(d.amount) : null,
      pastille: libellePastille(parcours),
      ton: parcours.ton,
      jours,
      delai: parcours.groupe === "VALIDE" ? "normal" as const : tonDelai(jours),
      valide: parcours.groupe === "VALIDE",
    }));

  // LES QUATRE TUILES — chaque dossier ouvert compte une fois, dans le groupe où il attend.
  const groupe = (g: Parcours["groupe"]) => lus.filter((l) => l.parcours.groupe === g);
  const aDeclarer = groupe("A_DECLARER");
  const pieces = groupe("PIECES");
  const pharmacien = groupe("A_VALIDER_PHARMACIEN").length;
  const direction = groupe("A_VALIDER_DIRECTION").length;
  const bons = groupe("BONS_FINANCES").length;
  const plusAncien = aDeclarer.reduce((m, l) => Math.max(m, l.jours ?? 0), 0);
  const personnes = new Set(
    pieces.flatMap((l) => l.d.requests.filter((r) => r.status === "PENDING").map((r) => r.targetUserId ?? r.id)),
  ).size;

  const tuiles = [
    { label: "À déclarer", value: aDeclarer.length, note: aDeclarer.length ? `le plus ancien : ${plusAncien} j` : null, ton: "" },
    { label: "Pièces attendues", value: pieces.length, note: pieces.length ? `chez ${personnes} personne${personnes > 1 ? "s" : ""}` : null, ton: pieces.length ? "text-warning" : "" },
    { label: "À valider", value: pharmacien + direction, note: pharmacien + direction ? `${pharmacien} pharmacien · ${direction} Directeur des Opérations` : null, ton: "" },
    { label: "Bons de versement", value: bons, note: bons ? "en paiement aux Finances" : null, ton: "" },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Information médicale"
        description="Déclarations au ministère, visas publicitaires, bons de versement"
      >
        <InfoBulle label="Les deux circuits">
          <strong>{CIRCUIT_LABEL.EVENT}</strong> — {CIRCUIT_HINT.EVENT}
          <br /><br />
          <strong>{CIRCUIT_LABEL.PROMO}</strong> — {CIRCUIT_HINT.PROMO}
        </InfoBulle>
        {/* LE PHARMACIEN N'ATTEND PAS TOUJOURS QU'UN DOSSIER LUI ARRIVE : une obligation se
            découvre aussi de son côté, et ce qui n'entre pas dans l'ERP se traite dans un carnet. */}
        {canOpen && <CreateDeclarationButton />}
      </PageHeader>

      {masques && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
          <Filter className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {masques}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tuiles.map((t) => (
          <Card key={t.label}>
            <CardContent className="space-y-0.5 py-4">
              <p className="text-xs text-muted-foreground">{t.label}</p>
              <p className={`text-2xl font-semibold tabular-nums ${t.ton}`}>{t.value}</p>
              <p className="truncate text-xs text-muted-foreground">{t.note ?? " "}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <DossiersTable lignes={lignes} />
    </div>
  );
}
