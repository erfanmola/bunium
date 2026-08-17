import { createSignal } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <div style={{ "font-family": "sans-serif", padding: "2rem" }}>
      <h1>__PROJECT_NAME__</h1>
      <p>A bunium + Solid + JavaScript app.</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        count is {count()}
      </button>
    </div>
  );
}
