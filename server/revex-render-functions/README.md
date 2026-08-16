# REVEX render broker

`runRevexRender` is a dedicated authenticated Firebase callable. It reuses the user's existing LIBER/Firebase session, verifies project membership, stores the clean viewport source under the existing project render namespace, and invokes the private GPU worker with a Google service identity token.

The callable does not expose the Cloud Run worker URL as a public render API, does not accept arbitrary model IDs or Storage paths, and does not require any Hugging Face credential from the user. The browser remains a thin job client; model loading and inference occur only on the private worker.
