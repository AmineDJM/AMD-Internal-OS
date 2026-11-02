import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { etatEcheance, joursAvant, LIBELLE_ETAT_ECHEANCE, LIBELLE_TYPE_MOYEN, libelleInstant, type TypeMoyen } from "@/modules/moyens-generaux/partage";
import { registreEtReservations } from "@/modules/moyens-generaux/api";

/**
 * LE REGISTRE DES MOYENS GÉNÉRAUX (lot T3) — véhicules, assurances, contrats de prestataires, entretiens, salles,
 * équipements, fournitures : chaque fiche, son échéance (dépassée, proche, à venir) et les réservations à venir.
 * Droit de VOIR « Moyens généraux ». Les fiches se créent et se mettent à jour par l'Assistant IA (carte confirmée,
 * annulable) ou par les actions `moyens-generaux-registre-actions`.
 */
export default async function RegistreMoyensGeneraux() {
  const user = await requireUser();
  if (!userCan(user, "GENERAL_MEANS", "VIEW")) notFound();
  const maintenant = new Date();
  const { moyens, reservations } = await registreEtReservations(maintenant);
  const alertes = moyens.filter((m) => { const e = etatEcheance(m.echeance, m.rappelJours, maintenant); return e === "depassee" || e === "proche"; });

  return (
    <div className="space-y-6">
      <PageHeader title="Registre des moyens généraux" description="Véhicules, assurances, contrats, entretiens, salles — et leurs échéances.">
        <Link href="/moyens-generaux" className="text-sm font-medium text-primary hover:underline">Caisse et dépenses</Link>
      </PageHeader>

      {alertes.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Échéances à traiter ({alertes.length})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {alertes.map((m) => {
              const j = joursAvant(m.echeance!, maintenant);
              return (
                <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 break-words"><span className="font-medium">{m.libelle}</span> · {LIBELLE_TYPE_MOYEN[m.type as TypeMoyen]}{m.parent ? ` · ${m.parent.libelle}` : ""}</span>
                  <Badge tone={j < 0 ? "danger" : "warning"}>{j < 0 ? `Dépassée depuis ${-j} j` : `Dans ${j} j`} — {formatDate(m.echeance!)}</Badge>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Fiches ({moyens.length})</CardTitle></CardHeader>
        <CardContent>
          {moyens.length === 0 ? (
            <EmptyState title="Aucune fiche au registre" description="Demandez à Adventum IA : « ajoute au registre le véhicule… », « l'assurance flotte est renouvelée jusqu'au… »." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr><th className="py-2 pr-3">Réf.</th><th className="py-2 pr-3">Nature</th><th className="py-2 pr-3">Libellé</th><th className="py-2 pr-3">Prestataire</th><th className="py-2 pr-3">Montant</th><th className="py-2 pr-3">Échéance</th></tr>
                </thead>
                <tbody>
                  {moyens.map((m) => {
                    const e = etatEcheance(m.echeance, m.rappelJours, maintenant);
                    return (
                      <tr key={m.id} className="border-t border-border align-top">
                        <td className="py-2 pr-3 whitespace-nowrap">{m.reference}</td>
                        <td className="py-2 pr-3">{LIBELLE_TYPE_MOYEN[m.type as TypeMoyen]}</td>
                        <td className="py-2 pr-3">{m.libelle}{m.identifiant ? <span className="text-muted-foreground"> · {m.identifiant}</span> : null}{m.capacite ? <span className="text-muted-foreground"> · {m.capacite} places</span> : null}{m.parent ? <span className="text-muted-foreground"> · {m.parent.libelle}</span> : null}</td>
                        <td className="py-2 pr-3">{m.prestataire ?? "—"}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{m.montant != null ? `${formatCurrency(Number(m.montant))}${m.periodicite ? ` / ${m.periodicite}` : ""}` : "—"}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{m.echeance ? <>{formatDate(m.echeance)} {e && e !== "a_venir" ? <Badge tone={e === "depassee" ? "danger" : "warning"}>{LIBELLE_ETAT_ECHEANCE[e]}</Badge> : null}</> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Réservations à venir</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {reservations.length === 0 ? <p className="text-muted-foreground">Aucune réservation à venir.</p> : reservations.map((r) => (
            <div key={r.id} className="flex flex-wrap justify-between gap-2">
              <span className="min-w-0 break-words"><span className="font-medium">{r.moyen.libelle}</span> — {r.objet}{r.participants ? ` (${r.participants} pers.)` : ""}</span>
              <span className="text-muted-foreground">{libelleInstant(r.debut)} → {libelleInstant(r.fin).slice(11)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
