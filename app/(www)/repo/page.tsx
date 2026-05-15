import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Repositories",
  description: "Open and explore saved GitHub repositories.",
};

export default function Page() {
  return <div className="p-3">Repo Page</div>;
}
