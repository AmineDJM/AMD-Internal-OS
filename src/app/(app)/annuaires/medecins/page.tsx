import { requireModule } from "@/lib/session";
import { FeuillePraticiensHub } from "../feuille-praticiens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Annuaires — Médecins — AMD Internal OS" };

/** Onglet MÉDECINS du module « Annuaires » : la feuille des praticiens, tout grade sauf pharmacien. */
export default async function AnnuaireMedecinsPage(
  props: { searchParams?: Promise<{ annuaire?: string; specialite?: string; archives?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("DIRECTORIES");
  return (
    <FeuillePraticiensHub
      user={user} grade="medecins" annuaire={searchParams?.annuaire ?? null}
      specialite={searchParams?.specialite ?? null} archives={searchParams?.archives === "1"}
    />
  );
}
