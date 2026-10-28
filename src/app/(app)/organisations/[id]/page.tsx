import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { natureLegale } from "@/lib/labels";
import { chargerFicheOrganisation } from "@/lib/referentiels/organisations/fiche";
import {
  LIBELLE_DEMANDE, LIBELLE_IDENTIFIANT, LIBELLE_ORIGINE_AFFILIATION, LIBELLE_ROLE_ORGANISATION, LIBELLE_SOURCE_FICHE,
} from "@/lib/referentiels/organisations/libelles";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Organisation — AMD Internal OS" };

const dateFr = (d: Date | null) => (d ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Algiers" }).format(d) : "—");
const montant = (v: string | null) => (v ? `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v))} DZD` : "—");
const NATURE_COORDONNEE: Record<string, string> = { ADRESSE: "Adresse", TELEPHONE: "Téléphone", EMAIL: "E-mail", SITE: "Site" };

function Bloc({ titre, vide, children }: { titre: string; vide: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle>{titre}</CardTitle></CardHeader>
      <CardContent className="text-sm">{vide ? <p className="text-muted-foreground">Rien de connu.</p> : children}</CardContent>
    </Card>
  );
}

/**
 * LA FICHE ORGANISATION 360° (lot V2-C) — en lecture. Chaque bloc derrière la porte de l'écran d'origine
 * (`referentiels/organisations/fiche.ts`) ; une organisation fusionnée renvoie à sa survivante. Sans RIB ni IBAN.
 */
export default async function OrganisationPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const fiche = await chargerFicheOrganisation(user, params.id);
  if (fiche.etat === "INTROUVABLE") notFound();
  if (fiche.etat === "FUSIONNEE") redirect(`/organisations/${fiche.survivanteId}`);
  const { organisation: o } = fiche;

  return (
    <div className="space-y-6">
      <PageHeader
        title={o.raisonSociale}
        description={[o.nomCourt, o.formeJuridique, o.pays !== "DZ" ? o.pays : null].filter(Boolean).join(" · ") || "Organisation"}
      >
        <div className="flex flex-wrap gap-1.5">
          {fiche.roles.map((r) => <Badge key={r} tone="info">{LIBELLE_ROLE_ORGANISATION[r] ?? r}</Badge>)}
          {o.statut !== "ACTIVE" && <Badge tone="warning">{o.statut.toLowerCase()}</Badge>}
        </div>
      </PageHeader>

      {fiche.absorbees.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Réunit aussi : {fiche.absorbees.map((a) => `« ${a.raisonSociale} »`).join(", ")} (fusion tracée).
        </p>
      )}
      {fiche.doublonsEnAttente > 0 && (
        <p className="text-sm">
          <Link href="/admin/refonte-donnees/organisations" className="font-medium text-primary hover:underline">
            {fiche.doublonsEnAttente} doublon(s) possible(s) à trancher
          </Link>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Bloc titre="Identifiants" vide={fiche.identifiants.length === 0}>
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
            {fiche.identifiants.map((i) => (
              <div key={`${i.type}${i.valeur}`} className="contents">
                <dt className="text-muted-foreground">{LIBELLE_IDENTIFIANT[i.type] ?? i.type}</dt>
                <dd className="font-mono">{i.valeur}</dd>
              </div>
            ))}
          </dl>
        </Bloc>

        <Bloc titre="Coordonnées" vide={fiche.coordonnees.length === 0}>
          <ul className="space-y-1">
            {fiche.coordonnees.map((c, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{NATURE_COORDONNEE[c.nature]} :</span> {c.valeur}{" "}
                <span className="text-xs text-muted-foreground">({c.source})</span>
              </li>
            ))}
          </ul>
        </Bloc>

        <Bloc titre="Fiches d'origine" vide={fiche.sources.length === 0}>
          <ul className="space-y-1">
            {fiche.sources.map((s) => (
              <li key={`${s.type}${s.id}`}>
                <Link href={s.lien} className="hover:underline">{s.libelle}</Link>{" "}
                <span className="text-xs text-muted-foreground">— {LIBELLE_SOURCE_FICHE[s.type]}{s.detail ? ` · ${s.detail}` : ""}</span>
              </li>
            ))}
          </ul>
        </Bloc>

        <Bloc titre="Personnes" vide={fiche.personnes.length === 0}>
          <ul className="space-y-1">
            {fiche.personnes.map((p, i) => (
              <li key={i}>
                <span className="font-medium">{p.nom}</span>
                {[p.fonction, p.service].filter(Boolean).length > 0 && <span> — {[p.fonction, p.service].filter(Boolean).join(", ")}</span>}{" "}
                <span className="text-xs text-muted-foreground">({p.origine ? LIBELLE_ORIGINE_AFFILIATION[p.origine] : "affiliation"}{p.principale ? ", principale" : ""})</span>
              </li>
            ))}
          </ul>
        </Bloc>
      </div>

      {fiche.pieces && (
        <Bloc titre={`Devis, bons de commande, factures et contrats (${fiche.pieces.total})`} vide={fiche.pieces.total === 0}>
          <ul className="space-y-1">
            {fiche.pieces.lignes.map((d) => (
              <li key={d.id}>
                <Link href={`/legal/${d.id}`} className="hover:underline">{d.reference ? `${d.reference} — ` : ""}{d.titre}</Link>{" "}
                <span className="text-xs text-muted-foreground">{natureLegale(d.nature)} · {dateFr(d.date)} · {montant(d.montant)}</span>
              </li>
            ))}
          </ul>
          {fiche.pieces.total > fiche.pieces.lignes.length && (
            <p className="mt-2 text-xs text-muted-foreground">Et {fiche.pieces.total - fiche.pieces.lignes.length} de plus, dans Legal.</p>
          )}
        </Bloc>
      )}

      <Bloc titre="Demandes Ad & Pro" vide={fiche.demandes.lignes.length === 0}>
        <ul className="space-y-1">
          {fiche.demandes.lignes.map((d) => (
            <li key={`${d.type}${d.id}`}>
              <Link href={d.lien} className="hover:underline">{d.libelle}</Link>{" "}
              <span className="text-xs text-muted-foreground">{LIBELLE_DEMANDE[d.type]} · {dateFr(d.date)}</span>
            </li>
          ))}
        </ul>
        {fiche.demandes.tronquee && <p className="mt-2 text-xs text-muted-foreground">Les plus récentes seulement : la liste complète est dans chaque module.</p>}
      </Bloc>
    </div>
  );
}
