"use strict";
const form = document.querySelector("#lookup");
const sample = document.querySelector("#sample");
function showSample() {
  if (!sample) return;
  sample.hidden = false;
  sample.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
document.querySelector("#show-sample")?.addEventListener("click", showSample);
if (location.hash === "#demo") showSample();
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = document.querySelector("#jap-id").value.trim();
  const valid = /^[0-9]{27}$/.test(value);
  document
    .querySelector("#jap-id")
    .setAttribute("aria-invalid", String(!valid));
  document.querySelector("#lookup-status").textContent = valid
    ? "Live verification is not enabled. This number has not been checked. Use the sample below to explore the proposed profile."
    : "Enter exactly 27 digits. Keep any leading zeros.";
});
document.querySelectorAll("[data-color]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector("#avatar-stage").style.backgroundColor =
      button.dataset.color;
  });
});
