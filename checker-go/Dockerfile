FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /checker ./cmd/checker

FROM gcr.io/distroless/static-debian12
COPY --from=build /checker /checker
EXPOSE 8081
USER nonroot:nonroot
ENTRYPOINT ["/checker"]
