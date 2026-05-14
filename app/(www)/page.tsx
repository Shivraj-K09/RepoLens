import { HomePageContent } from "@/components/landing/home-landing";

export const metadata = {
  title: "Repo Lens — GitHub repository assistant",
  description:
    "Paste a GitHub repository URL to explore and chat about the codebase.",
};

export default function Home() {
  return <HomePageContent />;
}
