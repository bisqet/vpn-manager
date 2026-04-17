export class PanelRequestError extends Error {
  readonly panelMessage: string;

  constructor(panelMessage: string) {
    super(panelMessage);
    this.name = "PanelRequestError";
    this.panelMessage = panelMessage;
  }
}
