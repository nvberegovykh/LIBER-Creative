module.exports = {
  daemon: true,
  run: [
    {
      method: "shell.run",
      params: {
        message: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File LOCALHOST.ps1",
        on: [
          {
            event: "/Local shell: (http:\\/\\/127\\.0\\.0\\.1:[0-9]+\\/)/",
            done: true
          }
        ]
      }
    },
    {
      method: "local.set",
      params: {
        url: "{{input.event[1]}}"
      }
    },
    {
      method: "notify",
      params: {
        html: "VRoid 2.14 Accessory Converter is ready. Open the Web UI button."
      }
    }
  ]
}
