# Deploy DI Next to Azure (demo)

Run these in **Azure Cloud Shell (Bash)** from the Azure portal. Every step starts from a fresh shell: it sets the subscription and reads the names saved in step 1 from `~/dinext.env`, which stays in your Cloud Shell home between sessions.

What gets created, all in **East US 2**, in one resource group:

| Resource | Purpose | Approximate cost |
|---|---|---|
| Azure Container Registry (Basic) | Holds the DI Next image, built in Azure from the GitHub repo | ~$5 / month |
| Azure Database for MySQL Flexible Server (Burstable B1ms, 32 GB) | The two synthetic tenant warehouses and the workflow store | ~$15–20 / month |
| Container Apps environment + Log Analytics | Runs the app and the seeding job; keeps console logs | Pay per use |
| Container App `dinext-app` (1 vCPU, 2 GiB, 1 replica) | The Experience server and the shell, on one HTTPS URL | ~$40–60 / month while running |
| Container Apps job `dinext-seed` | Loads the synthetic data, run once | Seconds of compute |

The demo is protected by a shared **access code** (step 6), not by sign-in. Entra ID sign-in is on the backlog.

---

## Step 1 · Names, passwords and the code (once)

```bash
az account set --subscription "Microsoft Azure Sponsorship"
az extension add --name containerapp --upgrade --only-show-errors
for p in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry Microsoft.DBforMySQL; do az provider register --namespace $p --only-show-errors; done

SUFFIX=$(openssl rand -hex 3)
cat > ~/dinext.env <<EOF
RG=rg-dinext-demo
LOCATION=eastus2
ACR=acrdinext$SUFFIX
MYSQL=mysql-dinext-$SUFFIX
ENVIRONMENT=cae-dinext
APP=dinext-app
JOB=dinext-seed
DB_ADMIN_USER=dinextadmin
DB_ADMIN_PASSWORD=$(openssl rand -hex 16)
DB_APP_PASSWORD=$(openssl rand -hex 16)
ACCESS_CODE=$(openssl rand -hex 4)
REPO=https://github.com/swarupd227/Kinective-DI-Next.git
EOF
chmod 600 ~/dinext.env
source ~/dinext.env
echo "Demo access code: $ACCESS_CODE"
```

Note the access code: you and your audience type it once per browser.

## Step 2 · Resource group, registry and image

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env

az group create --name $RG --location $LOCATION --output none
az acr create --name $ACR --resource-group $RG --location $LOCATION --sku Basic --output none

rm -rf ~/Kinective-DI-Next && git clone --depth 1 $REPO ~/Kinective-DI-Next
cd ~/Kinective-DI-Next
TAG=$(git rev-parse --short HEAD)
az acr build --registry $ACR --image dinext:$TAG --image dinext:latest --file app/Dockerfile app
echo "TAG=$TAG" >> ~/dinext.env
```

The build runs in Azure (about 5 minutes); Cloud Shell needs no Docker.

## Step 3 · MySQL Flexible Server

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env

az mysql flexible-server create \
  --resource-group $RG --name $MYSQL --location $LOCATION \
  --admin-user $DB_ADMIN_USER --admin-password "$DB_ADMIN_PASSWORD" \
  --sku-name Standard_B1ms --tier Burstable --storage-size 32 --version 8.0.21 \
  --public-access 0.0.0.0 --high-availability Disabled --yes --output none
```

About 5–10 minutes. `--public-access 0.0.0.0` allows connections from Azure services only (the app and the seeding job); TLS is required.

## Step 4 · Container Apps environment

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env

az containerapp env create --name $ENVIRONMENT --resource-group $RG --location $LOCATION --output none
```

## Step 5 · Load the synthetic data (seeding job)

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env
DB_HOST=$MYSQL.mysql.database.azure.com
ACR_SERVER=$(az acr show --name $ACR --query loginServer -o tsv)

az containerapp job create --name $JOB --resource-group $RG --environment $ENVIRONMENT \
  --trigger-type Manual --replica-timeout 1800 --replica-retry-limit 0 --parallelism 1 --replica-completion-count 1 \
  --image $ACR_SERVER/dinext:$TAG --registry-server $ACR_SERVER --registry-identity system \
  --cpu 1 --memory 2Gi \
  --secrets "admin-url=mysql://$DB_ADMIN_USER:$DB_ADMIN_PASSWORD@$DB_HOST:3306" "app-url=mysql://dinext:$DB_APP_PASSWORD@$DB_HOST:3306" "app-password=$DB_APP_PASSWORD" \
  --env-vars DI_DB_ADMIN_URL=secretref:admin-url DI_DB_URL=secretref:app-url DI_DB_APP_PASSWORD=secretref:app-password DI_DB_SSL=1 \
  --command npm run db:seed --output none

az containerapp job start --name $JOB --resource-group $RG --output none
echo "Seeding: this takes 2–5 minutes."
until s=$(az containerapp job execution list --name $JOB --resource-group $RG --query "[0].properties.status" -o tsv); [ "$s" != "Running" ] && [ -n "$s" ]; do sleep 15; echo "  $s"; done
echo "Seeding finished: $s"
```

It should end with `Succeeded`. If it says `Failed`, show the job's log with
`az monitor log-analytics query -w $(az containerapp env show -n $ENVIRONMENT -g $RG --query properties.appLogsConfiguration.logAnalyticsConfiguration.customerId -o tsv) --analytics-query "ContainerAppConsoleLogs_CL | where ContainerJobName_s == '$JOB' | project Log_s | take 50" -o tsv`.

## Step 6 · Run the app

Have your **Claude API key** and your **Azure AI Speech key and region** ready. You can leave either blank: without the Claude key the agents use the offline planner; without the Speech key voice is off. They are read silently and stored only as Container App secrets.

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env
DB_HOST=$MYSQL.mysql.database.azure.com
ACR_SERVER=$(az acr show --name $ACR --query loginServer -o tsv)

read -s -p "Claude API key (blank for offline): " ANTHROPIC_KEY; echo
read -s -p "Azure Speech key (blank for no voice): " SPEECH_KEY; echo
read -p "Azure Speech region, such as eastus (blank for no voice): " SPEECH_REGION

SECRETS=("db-url=mysql://dinext:$DB_APP_PASSWORD@$DB_HOST:3306" "access-code=$ACCESS_CODE")
ENVS=(DI_DB_URL=secretref:db-url DI_DB_SSL=1 DI_DEMO_ACCESS_CODE=secretref:access-code)
[ -n "$ANTHROPIC_KEY" ] && SECRETS+=("anthropic-key=$ANTHROPIC_KEY") && ENVS+=(DI_ANTHROPIC_API_KEY=secretref:anthropic-key)
[ -n "$SPEECH_KEY" ] && [ -n "$SPEECH_REGION" ] && SECRETS+=("speech-key=$SPEECH_KEY") && ENVS+=(DI_AZURE_SPEECH_KEY=secretref:speech-key DI_AZURE_SPEECH_REGION=$SPEECH_REGION)

az containerapp create --name $APP --resource-group $RG --environment $ENVIRONMENT \
  --image $ACR_SERVER/dinext:$TAG --registry-server $ACR_SERVER --registry-identity system \
  --target-port 8787 --ingress external --transport auto \
  --min-replicas 1 --max-replicas 1 --cpu 1 --memory 2Gi \
  --secrets "${SECRETS[@]}" --env-vars "${ENVS[@]}" --output none
unset ANTHROPIC_KEY SPEECH_KEY

URL=https://$(az containerapp show --name $APP --resource-group $RG --query properties.configuration.ingress.fqdn -o tsv)
echo "DI Next: $URL   (access code: $ACCESS_CODE)"
```

Open the URL, enter the access code, and pick a persona from the user menu. The server's first log line says which mode it is in:

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env
az containerapp logs show --name $APP --resource-group $RG --tail 20
```

It should include `live agents on Claude` (or `offline planner`) and `voice: azure` (or `off`).

---

## Updating after new commits

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env

rm -rf ~/Kinective-DI-Next && git clone --depth 1 $REPO ~/Kinective-DI-Next
cd ~/Kinective-DI-Next
TAG=$(git rev-parse --short HEAD)
az acr build --registry $ACR --image dinext:$TAG --image dinext:latest --file app/Dockerfile app
ACR_SERVER=$(az acr show --name $ACR --query loginServer -o tsv)
az containerapp update --name $APP --resource-group $RG --image $ACR_SERVER/dinext:$TAG --output none
az containerapp job update --name $JOB --resource-group $RG --image $ACR_SERVER/dinext:$TAG --output none
sed -i "s/^TAG=.*/TAG=$TAG/" ~/dinext.env
```

If a release changes the data (the README says "run `npm run db:seed`"), run the job again: `az containerapp job start --name $JOB --resource-group $RG`. Reseeding resets every tenant, including demo referrals, reports and schedules.

## Changing the code, keys or scale

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env
# A new access code:
NEW_CODE=$(openssl rand -hex 4); sed -i "s/^ACCESS_CODE=.*/ACCESS_CODE=$NEW_CODE/" ~/dinext.env
az containerapp secret set --name $APP --resource-group $RG --secrets "access-code=$NEW_CODE" --output none
az containerapp revision restart --name $APP --resource-group $RG --revision $(az containerapp show -n $APP -g $RG --query properties.latestRevisionName -o tsv)
echo "New access code: $NEW_CODE"
```

To stop paying for the app between demos: `az containerapp update -n $APP -g $RG --min-replicas 0` (the first visit then takes about a minute), and `az mysql flexible-server stop -g $RG -n $MYSQL` (start it again with `start` before the next demo).

## Removing everything

```bash
az account set --subscription "Microsoft Azure Sponsorship"
source ~/dinext.env
az group delete --name $RG --yes --no-wait
rm -f ~/dinext.env
```

## Demo limits

- **One replica, one shared demo session.** Conversations and the persona live in the server's memory. Everyone using the demo URL at the same time shares the persona switch, and a restart clears conversations (approvals, referrals, reports and schedules stay in MySQL).
- **No sign-in.** The access code keeps the URL from being used by strangers; it does not identify people. Entra ID sign-in, per-user sessions and class-based access are on the backlog.
- **Audit log is not durable.** It is written inside the container (`/tmp/dinext-data`) and lost on restart; production writes to tenant-encrypted storage (spec 26.10).
- **Secrets are Container App secrets.** Key Vault with managed identity is the production step.
