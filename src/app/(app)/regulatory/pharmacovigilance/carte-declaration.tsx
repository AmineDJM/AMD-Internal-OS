import { Info as InfoIcon, Landmark } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import { AVERTISSEMENT_DELAIS_PV, IMPUTABILITE_PV, estImputabilitePv, jourAlgerPv, jourFrPv, type EtatEcheancePv } from "@/lib/pharmacovigilance/declaration";
import { formatDate, formatDateTime } from "@/lib/utils";

const TON_BADGE = { neutral: "neutral", warning: "warning", danger: "danger" } as const;
const SOURCE: Record<EtatEcheancePv["source"], string> = {
  EVALUATION: "gravité évaluée",
  SIGNALEMENT: "gravité signalée, cas pas encore évalué",
  PRUDENCE: "gravité inconnue : délai le plus court",
};

/**
 * LA DÉCLARATION À L'AUTORITÉ, sur la fiche du cas (Super Admin, 24/11/2026) — l'échéance tant qu'elle court, puis
 * l'évaluation, la déclaration enregistrée, l'accusé et le visa du pharmacien responsable. Lecture seule : les gestes
 * sont dans la colonne « Instruction ».
 */
export function CarteDeclarationPv({ cas, echeance, nom, visaRequis }: {
  cas: {
    status: string; dateConnaissance: Date;
    evalGrave: boolean | null; evalAttendu: boolean | null; evalImputabilite: string | null; evalNote: string | null; evalueLe: Date | null; evalueParId: string | null;
    declareLe: Date | null; declarationReference: string | null; declareParId: string | null; accuseLe: Date | null; accuseReference: string | null;
    visaPharmacienLe: Date | null; visaPharmacienParId: string | null; visaPharmacienNote: string | null;
  };
  echeance: EtatEcheancePv | null;
  nom: (id: string | null) => string;
  visaRequis: boolean;
}) {
  return (
    <Card className={echeance && echeance.ton === "danger" ? "border-destructive/50" : undefined}>
      <CardHeader><CardTitle className="flex items-center gap-2"><Landmark className="h-4 w-4" /> Déclaration à l&apos;autorité</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {echeance && (
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge map={{ x: { label: echeance.libelle, tone: TON_BADGE[echeance.ton] } }} value="x" />
            <span className="text-xs text-muted-foreground">
              {echeance.delaiJours} j après la connaissance du cas (le {jourFrPv(jourAlgerPv(cas.dateConnaissance))}) — {SOURCE[echeance.source]}
            </span>
            <span title={AVERTISSEMENT_DELAIS_PV} aria-label={AVERTISSEMENT_DELAIS_PV} className="text-muted-foreground"><InfoIcon className="h-3.5 w-3.5" /></span>
          </div>
        )}

        {cas.evalueLe ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Champ label="Gravité">{cas.evalGrave ? <span className="text-destructive">Grave</span> : "Non grave"}</Champ>
            <Champ label="Effet">{cas.evalAttendu ? "Attendu" : "Inattendu"}</Champ>
            <Champ label="Imputabilité">{estImputabilitePv(cas.evalImputabilite) ? IMPUTABILITE_PV[cas.evalImputabilite] : "—"}</Champ>
            {cas.evalNote && <p className="whitespace-pre-wrap sm:col-span-3">{cas.evalNote}</p>}
            <p className="text-xs text-muted-foreground sm:col-span-3">Évalué par {nom(cas.evalueParId)} le {formatDateTime(cas.evalueLe)}.</p>
          </div>
        ) : (
          cas.status !== "CLOS" && <p className="text-muted-foreground">À évaluer : gravité, caractère attendu, imputabilité.</p>
        )}

        {cas.declareLe ? (
          <div className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-3">
            <Champ label="Déclaré le">{formatDate(cas.declareLe)}</Champ>
            <Champ label="Référence">{cas.declarationReference ?? "—"}</Champ>
            <Champ label="Accusé de réception">
              {cas.accuseLe ? `${formatDate(cas.accuseLe)}${cas.accuseReference ? ` — ${cas.accuseReference}` : ""}` : <span className="text-muted-foreground">En attente</span>}
            </Champ>
            <p className="text-xs text-muted-foreground sm:col-span-3">Enregistrée par {nom(cas.declareParId)} — la pièce est dans les pièces jointes.</p>
            {(visaRequis || cas.visaPharmacienLe) && (
              <Champ label="Visa du pharmacien responsable" large>
                {cas.visaPharmacienLe
                  ? `${nom(cas.visaPharmacienParId)}, le ${formatDateTime(cas.visaPharmacienLe)}${cas.visaPharmacienNote ? ` — ${cas.visaPharmacienNote}` : ""}`
                  : <span className="text-warning">Attendu</span>}
              </Champ>
            )}
          </div>
        ) : (
          cas.status === "CLOS" && <p className="text-muted-foreground">Clos sans déclaration à l&apos;autorité.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Champ({ label, children, large }: { label: string; children: React.ReactNode; large?: boolean }) {
  return (
    <div className={large ? "min-w-0 sm:col-span-3" : "min-w-0"}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}
