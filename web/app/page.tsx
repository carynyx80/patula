import { Hero, Marquee, Nav } from "@/components/Hero";
import ModeDemo from "@/components/ModeDemo";
import { CTA, Footer, Guarantees, HowItWorks, Proof } from "@/components/Sections";

export default function Page() {
  return (
    <main>
      <Nav />
      <Hero />
      <Marquee />
      <ModeDemo />
      <HowItWorks />
      <Guarantees />
      <Proof />
      <CTA />
      <Footer />
    </main>
  );
}
