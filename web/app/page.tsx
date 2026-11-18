import { Hero, Marquee, Nav } from "@/components/Hero";
import ModeDemo from "@/components/ModeDemo";
import { CTA, Footer, Guarantees, HowItWorks, Proof } from "@/components/Sections";
import TokenSection from "@/components/TokenSection";

export default function Page() {
  return (
    <main>
      <Nav />
      <Hero />
      <Marquee />
      <ModeDemo />
      <HowItWorks />
      <Guarantees />
      <TokenSection />
      <Proof />
      <CTA />
      <Footer />
    </main>
  );
}
